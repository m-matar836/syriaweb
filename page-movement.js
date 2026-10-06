// ===================================================================
//   6. منطق صفحة سحب / مرتجع مواد (materialsMovement.html) — مبنية على المستخدم
// ===================================================================
// تعرض هذه الصفحة محصلة المستخدم الحالي (سحب/مرتجع/صرف/مبيعات).
// المبيعات تُرسل يدوياً بعد اختيار التقرير المستهدف، بينما المصاريف تُسجّل تلقائياً
// كحركة "صرف" في festivalMovement عند حفظ أو تعديل أي تقرير.
const DIRECT_SALE_EVENT_NAME = 'ترويج وبيع مباشر';
async function handleMaterialsMovementPage() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    if (!currentUser) { if (typeof navigateTo === 'function') navigateTo('login'); else window.location.href = 'index.html'; return; }

    const toastContainer = document.getElementById('toast-notification');
    const toastMessage = toastContainer.querySelector('.toast-message');
    const showToast = (message, isError = false) => {
        toastMessage.textContent = message;
        toastMessage.classList.toggle('error', isError);
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 3000);
    };

    const userInfoBox = document.getElementById('reportInfoBox');
    const movementTableBody = document.getElementById('movement-table-body');
    const addMovementRowBtn = document.getElementById('addMovementRowBtn');
    const saveMovementBtn = document.getElementById('saveMovementBtn');
    const movementHistoryBody = document.getElementById('movement-history-body');
    const inventorySummaryBody = document.getElementById('inventory-summary-body');
    const movementEntryCard = document.getElementById('movementEntryCard');
    const closeOutTallyBtnEl = document.getElementById('closeOutTallyBtn');
    const employeeFilterWrap = document.getElementById('movementEmployeeFilterWrap');
    const employeeFilterSelect = document.getElementById('movementEmployeeFilterSelect');

    // النطاق المعروض حالياً: نفسي بشكل افتراضي، أو موظف آخر يختاره admin/manager من القائمة.
    let viewingTargetId = String(currentUser.id || '');
    let viewingTargetName = String(currentUser.name || '');
    const isViewingSelf = () => viewingTargetId === String(currentUser.id || '');

    function updateMovementScopeUI() {
        userInfoBox.classList.remove('d-none');
        userInfoBox.innerHTML = isViewingSelf()
            ? `<i class="fa-solid fa-user me-1"></i> محصلة السحب/المرتجع الخاصة بك: <strong>${currentUser.name || ''}</strong>`
            : `<i class="fa-solid fa-user-group me-1"></i> عرض بيانات الموظف: <strong>${viewingTargetName || ''}</strong> (وضع للعرض فقط)`;
        // تسجيل حركة جديدة وإرسال صافي المحصلة يبقيان دائماً مرتبطين بحسابك أنت فقط،
        // لذا يُخفيان عند تصفّح بيانات موظف آخر لتفادي أي التباس.
        if (movementEntryCard) movementEntryCard.style.display = isViewingSelf() ? '' : 'none';
        if (closeOutTallyBtnEl) closeOutTallyBtnEl.style.display = isViewingSelf() ? '' : 'none';
    }

    const productModal = new bootstrap.Modal(document.getElementById('movementProductSelectionModal'));
    const productSearchInput = document.getElementById('movementProductSearchInput');
    const productSelectionTbody = document.querySelector('#movementProductSelectionTable tbody');
    const addSelectedProductsBtn = document.getElementById('addSelectedMovementProductsBtn');

    let DB = null;

    const isCancelledProduct = (product) => {
        if (!product) return true;
        const value = String(product.cancelled ?? '').trim().toLowerCase();
        return product.cancelled === true || value === 'true' || value === '1' || value === 'yes' || value === 'نعم';
    };

    // كل مواد كل الحملات مجمّعة (بدون تكرار)، لأن الصفحة لم تعد مرتبطة بحملة/تقرير واحد.
    function getAllSellableProducts() {
        if (!DB || !DB.products) return [];
        const map = new Map();
        Object.values(DB.products).flat().forEach(p => {
            if (p && p.name && String(p.category ?? '').trim() === 'مادة تذوق' && !isCancelledProduct(p) && !map.has(p.name)) {
                map.set(p.name, p);
            }
        });
        return Array.from(map.values());
    }

    updateMovementScopeUI();

    // -----------------------------------------------------------------
    // إضافة صف حركة جديد (مادة + كمية + عملية)
    // -----------------------------------------------------------------
    function createMovementRow(productName) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <input type="text" class="form-control movement-product" value="${productName}" readonly>
            </td>
            <td>
                <input type="number" class="form-control movement-quantity" min="1" step="1" value="1">
            </td>
            <td>
                <input type="text" class="form-control movement-invoice" placeholder="اختياري">
            </td>
            <td>
                <select class="form-select movement-operation">
                    <option value="سحب">سحب</option>
                    <option value="مرتجع">مرتجع</option>
                </select>
            </td>
            <td class="text-center">
                <button type="button" class="btn btn-sm btn-outline-danger remove-movement-row"><i class="fa-solid fa-trash"></i></button>
            </td>`;
        tr.querySelector('.remove-movement-row').addEventListener('click', () => tr.remove());
        movementTableBody.appendChild(tr);
    }

    function populateProductModal() {
        const products = getAllSellableProducts();
        productSelectionTbody.innerHTML = '';
        products.forEach(p => {
            productSelectionTbody.insertAdjacentHTML('beforeend', `<tr><td><div class="form-check"><input class="form-check-input movement-product-check" type="checkbox" value="${p.name}" style="pointer-events:none;"></div></td><td>${p.name}</td></tr>`);
        });
        productSearchInput.value = '';
        productSearchInput.dispatchEvent(new Event('input'));
    }

    productSelectionTbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (!row) return;
        const checkbox = row.querySelector('.form-check-input');
        if (checkbox) checkbox.checked = !checkbox.checked;
    });

    productSearchInput.addEventListener('input', () => {
        const s = productSearchInput.value.toLowerCase().trim();
        productSelectionTbody.querySelectorAll('tr').forEach(r => {
            r.style.display = r.cells[1].textContent.toLowerCase().includes(s) ? '' : 'none';
        });
    });

    addMovementRowBtn.addEventListener('click', () => {
        populateProductModal();
        productModal.show();
    });

    addSelectedProductsBtn.addEventListener('click', () => {
        productSelectionTbody.querySelectorAll('.movement-product-check:checked').forEach(c => createMovementRow(c.value));
        productModal.hide();
    });

    // -----------------------------------------------------------------
    // حفظ الحركة (سحب/مرتجع) إلى festivalMovement — مرتبطة بالمستخدم الحالي
    // -----------------------------------------------------------------
    saveMovementBtn.addEventListener('click', async () => {
        const rows = Array.from(movementTableBody.querySelectorAll('tr'));
        if (!rows.length) { showToast('يرجى إضافة مادة واحدة على الأقل.', true); return; }

        const items = [];
        for (const row of rows) {
            const item = row.querySelector('.movement-product').value.trim();
            const quantity = Number(row.querySelector('.movement-quantity').value);
            const operation = row.querySelector('.movement-operation').value;
            const invoiceNumber = row.querySelector('.movement-invoice').value.trim();
            if (!item) { showToast('اسم المادة مطلوب.', true); return; }
            if (!Number.isFinite(quantity) || quantity <= 0) { showToast(`الكمية غير صحيحة للمادة: ${item}`, true); return; }
            items.push({ item, quantity, operation, invoiceNumber });
        }

        saveMovementBtn.disabled = true;
        saveMovementBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الحفظ...';
        try {
            const payload = { items, createdById: String(currentUser.id || ''), createdByName: String(currentUser.name || '') };
            if (!navigator.onLine) { await queueMovementOffline(payload); showToast('تم حفظ الحركة محلياً وستتم مزامنتها عند عودة الإنترنت.'); movementTableBody.innerHTML=''; updateOfflineStatus(); return; }
            const result = await apiPost('addFestivalMovement', payload);
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل حفظ الحركة');
            showToast('تم حفظ الحركة بنجاح.');
            movementTableBody.innerHTML = '';
            invalidateReportsCache(); window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
            await refreshMovementsAndSummary();
        } catch (e) {
            if (!navigator.onLine || /failed to fetch|network|load failed/i.test(String(e.message||''))) {
                try { await queueMovementOffline({items,createdById:String(currentUser.id||''),createdByName:String(currentUser.name||'')}); movementTableBody.innerHTML=''; showToast('تعذر الاتصال — تم حفظ الحركة محلياً للمزامنة تلقائياً.'); updateOfflineStatus(); } catch(qe) { showToast(qe.message||'تعذر الحفظ المحلي',true); }
            } else showToast(e.message || 'حدث خطأ أثناء حفظ الحركة', true);
        } finally {
            saveMovementBtn.disabled = false;
            saveMovementBtn.innerHTML = '<i class="fa-solid fa-floppy-disk me-1"></i> حفظ الحركة';
        }
    });

    // -----------------------------------------------------------------
    // جلب سجل حركات المستخدم وبناء محصلته (سحب - مرتجع - صرف - مبيعات لكل مادة)
    // -----------------------------------------------------------------
    function operationBadge(operation) {
        if (operation === 'سحب') return '<span class="badge bg-danger">سحب</span>';
        if (operation === 'مرتجع') return '<span class="badge bg-success">مرتجع</span>';
        if (operation === 'صرف') return '<span class="badge bg-warning text-dark">صرف (تلقائي)</span>';
        if (operation === 'مبيعات') return '<span class="badge bg-primary">مبيعات</span>';
        return `<span class="badge bg-secondary">${operation}</span>`;
    }

    // V66: اعتماد/رفض حركة سحب/مرتجع — admin/manager/auditor.
    const movRole = String(currentUser.role || '').trim().toLowerCase();
    const canReviewMov = movRole === 'admin' || movRole === 'manager' || movRole === 'auditor';
    const approveAllMovementsBtn = document.getElementById('approveAllMovementsBtn');
    if (approveAllMovementsBtn) approveAllMovementsBtn.classList.toggle('d-none', movRole !== 'admin' && movRole !== 'manager');
    approveAllMovementsBtn?.addEventListener('click', async () => {
        if (!confirm('سيتم اعتماد جميع الحركات قيد المراجعة ضمن نطاقك الحالي. الحركات المرفوضة لن تتغير. هل تريد المتابعة؟')) return;
        const original = approveAllMovementsBtn.innerHTML;
        approveAllMovementsBtn.disabled = true;
        approveAllMovementsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري الاعتماد...';
        try {
            const targetUserId = employeeFilterSelect?.value || '';
            const result = await apiPost('approveAllMovements', { role: currentUser.role || '', targetUserId });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر اعتماد الحركات');
            showToast(result.message || `تم اعتماد ${result.approved || 0} حركة.`);
            await refreshMovementsAndSummary(viewingTargetId);
        } catch (e) {
            showToast(`تعذر اعتماد الكل: ${e.message || e}`, true);
        } finally {
            approveAllMovementsBtn.disabled = false;
            approveAllMovementsBtn.innerHTML = original;
        }
    });

    const reviewMovement = async (button, id, status) => {
        try {
            const rejectReason = status === 'rejected' ? (window.prompt('سبب رفض الحركة:') || '').trim() : '';
            if (status === 'rejected' && !rejectReason) { alert('يرجى كتابة سبب الرفض.'); return; }
            if (status === 'approved' && !confirm('اعتماد هذه الحركة؟')) return;
            button.disabled = true;
            const original = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const result = await apiPost('approveMovement', { id, role: currentUser.role || '', status, reason: rejectReason, approvedBy: currentUser.name || '', approvedAt: new Date().toISOString() });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل العملية');
            showToast(status === 'approved' ? 'تم اعتماد الحركة.' : 'تم رفض الحركة.');
            await refreshMovementsAndSummary(viewingTargetId);
        } catch (e) {
            button.disabled = false;
            button.innerHTML = original;
            showToast(`تعذر ${status === 'approved' ? 'اعتماد' : 'رفض'} الحركة: ${e.message || e}`, true);
        }
    };

    // -----------------------------------------------------------------
    // سجل الحركات + محصلتي — مع فلتر حالة المراجعة (الكل/معتمد/مرفوض/قيد المراجعة).
    // -----------------------------------------------------------------
    const movementApprovalFilter = document.getElementById('movementApprovalFilter');
    const movementCountSpan = document.getElementById('movementCount');
    let allMovements = [];

    const movementApprovalOf = (m) => m.approvalStatus === 'approved' ? 'approved' : (m.approvalStatus === 'rejected' ? 'rejected' : 'pending');

    function renderMovementHistory() {
        const f = (movementApprovalFilter && movementApprovalFilter.value) || '';
        const filtered = f ? allMovements.filter(m => movementApprovalOf(m) === f) : allMovements;
        if (movementCountSpan) movementCountSpan.textContent = `${filtered.length} حركة`;
        if (!allMovements.length) {
            movementHistoryBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">لا توجد حركات مسجلة بعد</td></tr>`;
            return;
        }
        movementHistoryBody.innerHTML = filtered.length ? filtered.map(m => {
            const badge = m.approvalStatus === 'approved' ? '<span class="badge bg-success">معتمد</span>' : (m.approvalStatus === 'rejected' ? '<span class="badge bg-danger">مرفوض</span>' : '<span class="badge bg-secondary">قيد المراجعة</span>');
            const canEditThis = m.approvalStatus === 'rejected' && (isViewingSelf() || canReviewMov);
            const review = `<span class="d-inline-block me-2">${badge}</span>` +
                (canEditThis ? `<button class="btn btn-sm btn-outline-primary edit-move-btn" data-id="${escapeHtmlSafe(m.id)}" data-item="${escapeHtmlSafe(m.item)}" data-qty="${m.quantity}" data-op="${escapeHtmlSafe(m.operation)}" data-inv="${escapeHtmlSafe(m.invoiceNumber)}" title="تعديل الحركة المرفوضة"><i class="fa-solid fa-pen"></i></button> ` : '') +
                (canReviewMov && m.approvalStatus !== 'approved' ? `<button class="btn btn-sm btn-outline-success approve-move-btn" data-id="${escapeHtmlSafe(m.id)}" title="اعتماد الحركة"><i class="fa-solid fa-check"></i></button> ` : '') +
                (canReviewMov && m.approvalStatus !== 'rejected' ? `<button class="btn btn-sm btn-outline-danger reject-move-btn" data-id="${escapeHtmlSafe(m.id)}" title="رفض الحركة"><i class="fa-solid fa-ban"></i></button>` : '');
            return `<tr><td>${escapeHtmlSafe(m.item)}</td><td>${escapeHtmlSafe(m.quantity)}</td><td>${m.invoiceNumber ? escapeHtmlSafe(m.invoiceNumber) : '-'}</td><td>${operationBadge(m.operation)}</td><td>${escapeHtmlSafe(m.date)}</td><td>${m.reportId ? escapeHtmlSafe(m.reportId) : '-'}</td><td>${escapeHtmlSafe(m.createdByName) || '-'}</td><td class="text-nowrap">${review}</td></tr>`;
        }).join('') : `<tr><td colspan="8" class="text-center text-muted">لا توجد حركات مطابقة للفلتر</td></tr>`;
        movementHistoryBody.querySelectorAll('.approve-move-btn').forEach(b => b.addEventListener('click', () => reviewMovement(b, b.dataset.id, 'approved')));
        movementHistoryBody.querySelectorAll('.reject-move-btn').forEach(b => b.addEventListener('click', () => reviewMovement(b, b.dataset.id, 'rejected')));
        movementHistoryBody.querySelectorAll('.edit-move-btn').forEach(b => b.addEventListener('click', () => openMovementEdit(b)));
    }

    // V69: تعديل حركة غير معتمدة (المرفوضة/قيد المراجعة) — المعتمدة لا تُعدَّل.
    const movementEditModalEl = document.getElementById('movementEditModal');
    const movementEditModal = movementEditModalEl ? new bootstrap.Modal(movementEditModalEl) : null;
    const movementEditIdEl = document.getElementById('movementEditId');
    const movementEditItemEl = document.getElementById('movementEditItem');
    const movementEditQuantityEl = document.getElementById('movementEditQuantity');
    const movementEditOperationEl = document.getElementById('movementEditOperation');
    const movementEditInvoiceEl = document.getElementById('movementEditInvoice');
    const saveMovementEditBtn = document.getElementById('saveMovementEditBtn');

    const openMovementEdit = (button) => {
        if (!movementEditModal) return;
        movementEditIdEl.value = button.dataset.id || '';
        movementEditItemEl.value = button.dataset.item || '';
        movementEditQuantityEl.value = button.dataset.qty || '';
        movementEditOperationEl.value = button.dataset.op || 'سحب';
        movementEditInvoiceEl.value = button.dataset.inv || '';
        movementEditModal.show();
    };

    saveMovementEditBtn?.addEventListener('click', async () => {
        const id = String(movementEditIdEl?.value || '').trim();
        const item = String(movementEditItemEl?.value || '').trim();
        const quantity = Number(movementEditQuantityEl?.value);
        const operation = String(movementEditOperationEl?.value || '').trim();
        const invoiceNumber = String(movementEditInvoiceEl?.value || '').trim();
        if (!id) { showToast('معرّف الحركة مفقود.', true); return; }
        if (!item) { showToast('اسم المادة مطلوب.', true); return; }
        if (!Number.isFinite(quantity) || quantity <= 0) { showToast('الكمية يجب أن تكون رقماً أكبر من 0.', true); return; }
        saveMovementEditBtn.disabled = true;
        const originalText = saveMovementEditBtn.innerHTML;
        saveMovementEditBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الحفظ...';
        try {
            const result = await apiPost('editFestivalMovement', { id, item, quantity, operation, invoiceNumber, createdById: String(currentUser.id || ''), createdByName: String(currentUser.name || '') });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل تعديل الحركة');
            showToast(result.message || 'تم تعديل الحركة وأصبحت قيد المراجعة.');
            movementEditModal.hide();
            await refreshMovementsAndSummary(viewingTargetId);
        } catch (e) {
            showToast(`تعذر تعديل الحركة: ${e.message || e}\n\nتأكد من نشر النسخة المحدّثة من Apps Script.`, true);
        } finally {
            saveMovementEditBtn.disabled = false;
            saveMovementEditBtn.innerHTML = originalText;
        }
    });

    function renderInventorySummary() {
        if (!allMovements.length) {
            inventorySummaryBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">لا توجد بيانات بعد</td></tr>`;
            return;
        }
        const summaryMap = new Map();
        allMovements.forEach(m => {
            if (!summaryMap.has(m.item)) summaryMap.set(m.item, { item: m.item, withdrawn: 0, returned: 0, expensed: 0, sold: 0 });
            const entry = summaryMap.get(m.item);
            const qty = Number(m.quantity) || 0;
            if (m.operation === 'سحب') entry.withdrawn += qty;
            else if (m.operation === 'مرتجع') entry.returned += qty;
            else if (m.operation === 'صرف') entry.expensed += qty;
            else if (m.operation === 'مبيعات') entry.sold += qty;
        });
        const summary = Array.from(summaryMap.values()).map(e => ({ ...e, remaining: e.withdrawn - e.returned - e.expensed - e.sold }));
        inventorySummaryBody.innerHTML = summary.map(e =>
            `<tr><td>${escapeHtmlSafe(e.item)}</td><td>${e.withdrawn}</td><td>${e.returned}</td><td>${e.expensed}</td><td>${e.sold}</td><td class="fw-bold ${e.remaining < 0 ? 'text-danger' : ''}">${e.remaining}</td></tr>`
        ).join('');
    }

    async function refreshMovementsAndSummary(targetId) {
        const scopedUserId = String(targetId || viewingTargetId || currentUser.id || '');
        movementHistoryBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>`;
        inventorySummaryBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>`;
        try {
            const result = await apiGet('getUserFestivalMovements', {
                userId: String(currentUser.id || ''),
                role: String(currentUser.role || ''),
                targetUserId: scopedUserId
            });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر تحميل الحركات');
            allMovements = Array.isArray(result.movements) ? result.movements : [];
            renderMovementHistory();
            renderInventorySummary();
        } catch (e) {
            movementHistoryBody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">تعذر تحميل السجل: ${escapeHtmlSafe(e.message || '')}</td></tr>`;
            inventorySummaryBody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">تعذر تحميل المحصلة</td></tr>`;
        }
    }

    // تغيير فلتر حالة المراجعة يعيد رسم السجل فوراً دون إعادة الجلب.
    movementApprovalFilter?.addEventListener('change', () => { if (allMovements.length) renderMovementHistory(); });

    // -----------------------------------------------------------------
    // إرسال صافي المحصلة إلى المبيعات — يختار المستخدم التقرير أولاً.
    // تُحفظ المبيعات في sales وfestivalMovement مع reportId المختار.
    // -----------------------------------------------------------------
    const closeOutTallyBtn = document.getElementById('closeOutTallyBtn');
    const salesReportModalEl = document.getElementById('salesReportSelectionModal');
    const salesReportModal = salesReportModalEl ? new bootstrap.Modal(salesReportModalEl) : null;
    const salesReportTbody = document.querySelector('#salesReportSelectionTable tbody');
    const salesReportSearchInput = document.getElementById('salesReportSearchInput');
    const salesReportStatus = document.getElementById('salesReportSelectionStatus');
    const confirmSalesReportBtn = document.getElementById('confirmSalesReportBtn');
    let salesReportCandidates = [];

    const escapeHtmlSafe = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

    function renderSalesReportCandidates() {
        if (!salesReportTbody) return;
        const q = String(salesReportSearchInput?.value || '').trim().toLowerCase();
        const filtered = salesReportCandidates.filter(r => {
            if (!q) return true;
            const text = [r.id,r.campaign,r.market,r.date,r.event,r.createdAt].map(v => String(v || '').toLowerCase()).join(' ');
            return text.includes(q);
        });
        salesReportTbody.innerHTML = filtered.length ? filtered.map((r, i) => `
            <tr>
                <td><input class="form-check-input sales-report-radio" type="radio" name="salesReportChoice" value="${escapeHtmlSafe(r.id)}"></td>
                <td>${escapeHtmlSafe(r.id)}</td>
                <td>${escapeHtmlSafe(r.campaign || '-')}</td>
                <td>${escapeHtmlSafe(r.market || '-')}</td>
                <td>${escapeHtmlSafe(r.date || '-')}</td>
                <td>${escapeHtmlSafe(r.event || '-')}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="text-center text-muted">لا توجد تقارير مطابقة</td></tr>';
        if (salesReportStatus) salesReportStatus.textContent = `عدد التقارير المتاحة: ${filtered.length}`;
    }

    async function loadReportsForSalesSelection() {
        if (!salesReportModal) throw new Error('نافذة اختيار التقرير غير متاحة');
        if (salesReportStatus) salesReportStatus.textContent = 'جاري تحميل تقاريرك...';
        if (salesReportTbody) salesReportTbody.innerHTML = '<tr><td colspan="6" class="text-center"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>';
        const reportsFromCache = await cachedReportsFetch({
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || '')
        }, { ttlMinutes: 2 });
        if (!Array.isArray(reportsFromCache)) throw new Error('تعذر تحميل التقارير');
        salesReportCandidates = reportsFromCache.slice().sort((a,b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
        renderSalesReportCandidates();
    }

    closeOutTallyBtn.addEventListener('click', async () => {
        try {
            await loadReportsForSalesSelection();
            salesReportSearchInput.value = '';
            renderSalesReportCandidates();
            salesReportModal.show();
        } catch (e) {
            showToast(e.message || 'تعذر تحميل التقارير لاختيار التقرير', true);
        }
    });

    salesReportSearchInput?.addEventListener('input', renderSalesReportCandidates);

    confirmSalesReportBtn?.addEventListener('click', async () => {
        const selected = document.querySelector('.sales-report-radio:checked');
        if (!selected) {
            showToast('يرجى اختيار التقرير الذي ستضاف إليه المبيعات', true);
            return;
        }
        const selectedReportId = String(selected.value || '').trim();
        if (!selectedReportId) return;
        if (!confirm('سيتم إرسال صافي محصلتك الحالي إلى التقرير المحدد وتسجيله في sales وfestivalMovement. متابعة؟')) return;

        confirmSalesReportBtn.disabled = true;
        const oldText = confirmSalesReportBtn.innerHTML;
        confirmSalesReportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الإرسال...';
        try {
            const result = await apiPost('closeOutUserTallyToSales', {
                createdById: String(currentUser.id || ''),
                createdByName: String(currentUser.name || ''),
                reportId: selectedReportId
            });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل إرسال صافي المحصلة');
            salesReportModal.hide();
            if (!result.added) showToast(result.message || 'لا توجد كميات متبقية لإرسالها.', true);
            else showToast(`تم إرسال ${result.added} مادة إلى التقرير ${selectedReportId} وتسجيلها في المبيعات وحركة المهرجان.`);
            invalidateReportsCache(); window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
            await refreshMovementsAndSummary();
        } catch (e) {
            showToast(e.message || 'حدث خطأ أثناء إرسال صافي المحصلة', true);
        } finally {
            confirmSalesReportBtn.disabled = false;
            confirmSalesReportBtn.innerHTML = oldText;
        }
    });

    // -----------------------------------------------------------------
    // القائمة المنسدلة لاختيار موظف معيّن — admin يرى الجميع، manager يرى فريقه فقط.
    // -----------------------------------------------------------------
    if (employeeFilterWrap && employeeFilterSelect) {
        const options = await fetchTeamOptions(currentUser);
        if (options.length) {
            employeeFilterSelect.innerHTML = `<option value="${currentUser.id}">أنا (${currentUser.name || ''})</option>` +
                options.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
            employeeFilterWrap.classList.remove('d-none');
            employeeFilterSelect.addEventListener('change', async () => {
                viewingTargetId = employeeFilterSelect.value || String(currentUser.id || '');
                const selectedOption = employeeFilterSelect.options[employeeFilterSelect.selectedIndex];
                viewingTargetName = isViewingSelf() ? currentUser.name : (selectedOption ? selectedOption.textContent : '');
                updateMovementScopeUI();
                await refreshMovementsAndSummary(viewingTargetId);
            });
        }
    }

    // -----------------------------------------------------------------
    // التهيئة الأولية — تظهر الحركة والمحصلة دائماً فور دخول المستخدم للصفحة
    // -----------------------------------------------------------------
    try {
        DB = await getDbData();
    } catch (e) {
        DB = { products: {} };
    }

    // V58: عند إعادة زيارة شاشة الحركة من قائمة التنقل نُعيد التحميل ليعكس آخر البيانات.
    window.addEventListener('spaViewRevisited', async (event) => {
        if (event.detail && event.detail.route !== 'movement') return;
        updateMovementScopeUI();
        await refreshMovementsAndSummary(viewingTargetId);
    });

    // بعد زر «تحديث البيانات»: نُحدّث محصلة الشاشة المفتوحة حالاً.
    window.addEventListener('appDataRefreshed', () => {
        if (!currentUser) return;
        updateMovementScopeUI();
        refreshMovementsAndSummary(viewingTargetId).catch(() => {});
    });

    await refreshMovementsAndSummary(viewingTargetId);
}

// V58: تسجيل شاشة الحركة في موجه الـ SPA.
if (typeof registerView === 'function') registerView('movement', handleMaterialsMovementPage);
