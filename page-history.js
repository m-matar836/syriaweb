// ===================================================================
//                      5. منطق صفحة سجل التعديلات
// ===================================================================
const QRCODE_LIB_SRC = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js';
// V60: تهريب قيم HTML لمنع حقن سكربتات من النصوص القادمة من Google Sheets.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// V60: مكتبة تصدير Excel تُحمَّل من CDN عند أول استخدام فقط (تتطلب اتصالاً).
const XLSX_LIB_SRC = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
let xlsxLoadPromise = null;
function loadXlsxLibrary() {
    if (typeof XLSX !== 'undefined') return Promise.resolve(XLSX);
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = XLSX_LIB_SRC;
        script.async = true;
        script.onload = () => resolve(typeof XLSX !== 'undefined' ? XLSX : null);
        script.onerror = () => resolve(null);
        document.body.appendChild(script);
    });
    return xlsxLoadPromise;
}
let qrcodeLoadPromise = null;
function loadQrcodeLibrary() {
    if (typeof QRCode !== 'undefined') return Promise.resolve(true);
    if (qrcodeLoadPromise) return qrcodeLoadPromise;
    qrcodeLoadPromise = new Promise((resolve) => {
        const existing = document.querySelector(`script[src="${QRCODE_LIB_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve(true));
            existing.addEventListener('error', () => resolve(false));
            return;
        }
        const script = document.createElement('script');
        script.src = QRCODE_LIB_SRC;
        script.async = true;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
    });
    return qrcodeLoadPromise;
}

// V63: طباعة / تحويل تقرير واحد إلى PDF عبر نافذة طباعة مهذّبة (تعمل دون إنترنت).
function openReportPrint(report) {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { alert('اسمح بالنوافذ المنبثقة لهذا الموقع لطباعة تقرير PDF.'); return; }
    const esc2 = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let salesTotal = 0, qtyTotal = 0;
    const salesRows = (report.sales || []).map(s => {
        const p = Number(s.price) || 0, q = Number(s.quantity) || 0;
        salesTotal += p * q; qtyTotal += q;
        return `<tr><td>${esc2(s.product)}</td><td>${p.toFixed(2)}</td><td>${q}</td><td>${(p * q).toFixed(2)}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">لا توجد مبيعات</td></tr>';
    const subSales = (report.sales || []).length > 0
        ? `<h4>المبيعات</h4><table><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead><tbody>${salesRows}</tbody><tfoot class="totals"><tr><td colspan="2">الإجمالي</td><td>${qtyTotal}</td><td>${salesTotal.toFixed(2)}</td></tr></tfoot></table>` : '';
    const compRows = (report.salesOfCompetitor || []).map(s => `<tr><td>${esc2(s.product)}</td><td>${Number(s.price || 0).toFixed(2)}</td><td>${esc2(s.quantity)}</td></tr>`).join('');
    const subComp = (report.salesOfCompetitor || []).length > 0 ? `<h4>مبيعات المنافس</h4><table><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th></tr></thead><tbody>${compRows}</tbody></table>` : '';
    const expRows = (report.expenses || []).map(e => `<tr><td>${esc2(e.item)}</td><td>${esc2(e.quantity)}</td></tr>`).join('');
    const subExp = (report.expenses || []).length > 0 ? `<h4>المصاريف</h4><table><thead><tr><th>المادة</th><th>الكمية</th></tr></thead><tbody>${expRows}</tbody></table>` : '';
    const promoters = (report.promoters || []).map(esc2).join('، ') || 'لا يوجد';
    const when = `${report.date} | ${report.timeFrom} - ${report.timeTo}`;
    const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير ${esc2(report.id)}</title><style>
body{font-family:'Segoe UI','Tahoma',Arial,sans-serif;color:#1e293b;margin:24px;line-height:1.6;}
h1{font-size:20px;margin:0 0 2px;} .sub{color:#64748b;font-size:12px;margin-bottom:18px;}
h4{margin:18px 0 8px;font-size:14px;} table{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:13px;}
th,td{border:1px solid #cbd5e1;padding:6px 10px;text-align:right;} th{background:#f1f5f9;}
td:first-child{font-weight:600;} tfoot.totals td{background:#eef2ff;font-weight:700;}
.muted{color:#94a3b8;text-align:center;} .meta{margin:0 0 3px;font-size:13px;} .meta b{display:inline-block;min-width:90px;}
.notes{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;font-size:13px;margin-top:14px;}
.footer{margin-top:30px;border-top:1px dashed #cbd5e1;padding-top:10px;font-size:11px;color:#94a3b8;}
@media print{body{margin:12px;}}
</style></head><body>
<h1>تقرير نقطة بيع</h1><div class="sub">رقم التقرير: ${esc2(report.id)} — أنشئ ${esc2(report.createdAt || '')}</div>
<p class="meta"><b>الحملة:</b> ${esc2(report.campaign)}</p>
<p class="meta"><b>المحل:</b> ${esc2(report.market)}</p>
<p class="meta"><b>الموقع:</b> ${esc2(report.governorate)} - ${esc2(report.region)}</p>
<p class="meta"><b>الحدث:</b> ${esc2(report.event)} (${esc2(report.eventDays)} أيام)</p>
<p class="meta"><b>التاريخ والوقت:</b> ${esc2(when)}</p>
<p class="meta"><b>المشرف:</b> ${esc2(report.supervisor)}</p>
<p class="meta"><b>المنسق:</b> ${esc2(report.coordinator)} — <b>تبعية الجرد:</b> ${esc2(report.inventoryDependency)}</p>
<p class="meta"><b>المروجون:</b> ${promoters}</p>
${report.latitude && report.longitude ? `<p class="meta"><b>الموقع الجغرافي:</b> ${esc2(report.latitude)}, ${esc2(report.longitude)}</p>` : ''}
${subSales}${subComp}${subExp}
${report.notes ? `<div class="notes"><b>ملاحظات:</b> ${esc2(report.notes)}</div>` : ''}
<div class="footer">طُبع بتاريخ ${new Date().toLocaleString('ar')}</div>
</body></html>`;
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
}

async function handleHistoryPage() {
    const reportsAccordion = document.getElementById('reports-accordion');
    const searchInput = document.getElementById('searchInput');
    const noResultsMessage = document.getElementById('no-results-message');
    const reportsCount = document.getElementById('reportsCount');

    // V70: عناصر الفلاتر تُقرأ هنا مبكراً. كانت تُقرأ أسفل الشاشة بعد
    // renderReports، فكان استدعاؤها من renderReports (عند Draw 438) يقع في
    // المنطقة الميتة (TDZ) ويرمي ReferenceError يوقف تشغيل الشاشة بالكامل.
    const historyCampaignFilter = document.getElementById('historyCampaignFilter');
    const historyEventFilter = document.getElementById('historyEventFilter');
    const historyStatusFilter = document.getElementById('historyStatusFilter');
    const historyIdFilter = document.getElementById('historyIdFilter');
    const clearHistoryFiltersBtn = document.getElementById('clearHistoryFiltersBtn');

    // V60: ربط زر نسخ رابط الـ QR مرة واحدة فقط (كان يُربط داخل renderReports فيتكرر مع كل إعادة رسم).
    const qrCopyLinkBtn = document.getElementById('qrCopyLinkBtn');
    if (qrCopyLinkBtn && qrCopyLinkBtn.dataset.qrCopyBound !== '1') {
        qrCopyLinkBtn.dataset.qrCopyBound = '1';
        qrCopyLinkBtn.addEventListener('click', () => {
            const linkInput = document.getElementById('qrEditLink');
            if (!linkInput?.value) return;
            navigator.clipboard?.writeText(linkInput.value);
        });
    }

    // V60: ترقيم السجل — تُعرض الدفعات بحد «عرض المزيد».
    const HISTORY_PAGE_SIZE = 20;
    let historyLimit = HISTORY_PAGE_SIZE;
    let orderedReports = [];
    let historyServerPage = 0;
    let historyServerHasMore = false;
    let historyServerLoading = false;
    let historyServerRequestSeq = 0;
    let historyServerPagedMode = true;
    let historyFilterDataLoaded = false;
    const loadMoreReportsBtn = document.getElementById('loadMoreReportsBtn');
    loadMoreReportsBtn?.addEventListener('click', async () => {
        if (!historyServerPagedMode) {
            historyLimit += HISTORY_PAGE_SIZE;
            renderReportSlice();
            return;
        }
        if (historyServerLoading || !historyServerHasMore) return;
        await loadHistoryServerPage(false);
    });
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    let currentReports = [];
    const userRole = String(currentUser?.role || '').trim().toLowerCase();
    const isAdmin = userRole === 'admin';
    const isManager = userRole === 'manager';
    const isAuditor = userRole === 'auditor';
    const historyTitle = document.getElementById('historyTitle');
    const employeeFilterWrap = document.getElementById('historyEmployeeFilterWrap');
    const employeeFilterSelect = document.getElementById('historyEmployeeFilterSelect');
    let selectedTargetId = 'all';
    let teamOptionsByName = new Map();

    const updateHistoryTitle = () => {
        if (!historyTitle) return;
        if (selectedTargetId && selectedTargetId !== 'all') {
            const name = teamOptionsByName.get(selectedTargetId) || '';
            historyTitle.textContent = name ? `سجل تقارير: ${name}` : 'سجل التقارير';
        } else if (isAdmin) {
            historyTitle.textContent = 'سجل جميع التقارير';
        } else if (isManager) {
            historyTitle.textContent = 'سجل تقارير فريقي';
        } else {
            historyTitle.textContent = 'سجل تقاريري';
        }
    };
    updateHistoryTitle();

    // V58: تمرير إلى تقرير معيّن بعد البناء — المصدر: window.__spaPendingScrollId (قيمة
    // خام من sessionStorage) أو رابط قديم بصيغة #c-<id>. تُبنى هوية العنصر هكذا c-<id>.
    const scrollToPendingReport = () => {
        const pendingScrollId = window.__spaPendingScrollId;
        window.__spaPendingScrollId = null;
        const legacyHashTarget = window.location.hash && window.location.hash.indexOf('#/') !== 0 ? window.location.hash.substring(1) : null;
        const targetId = pendingScrollId ? 'c-' + pendingScrollId : legacyHashTarget;
        if (!targetId) return;
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
            new bootstrap.Collapse(targetElement).show();
            targetElement.scrollIntoView({ behavior: 'smooth' });
        }
    };

    const approveAllReportsBtn = document.getElementById('approveAllReportsBtn');
    const updateApproveAllReportsButton = () => {
        const role = String(currentUser?.role || '').toLowerCase();
        approveAllReportsBtn?.classList.toggle('d-none', role !== 'admin' && role !== 'manager');
    };
    approveAllReportsBtn?.addEventListener('click', async () => {
        if (!confirm('سيتم اعتماد جميع التقارير قيد المراجعة ضمن نطاقك الحالي. التقارير المرفوضة لن تتغير. هل تريد المتابعة؟')) return;
        const original = approveAllReportsBtn.innerHTML;
        approveAllReportsBtn.disabled = true;
        approveAllReportsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري الاعتماد...';
        try {
            const targetUserId = document.getElementById('historyEmployeeFilterSelect')?.value || '';
            const result = await apiPost('approveAllReports', { role: currentUser.role || '', targetUserId });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر اعتماد التقارير');
            alert(result.message || `تم اعتماد ${result.approved || 0} تقرير.`);
            const fresh = await cachedReportsFetch({ userId:String(currentUser.id||''), role:String(currentUser.role||''), userName:String(currentUser.name||''), targetUserId:targetUserId || 'all' }, { force:true });
            currentReports = Array.isArray(fresh) ? fresh : currentReports;
            renderReports(currentReports);
        } catch (e) {
            alert(`تعذر اعتماد الكل: ${e.message || e}`);
        } finally {
            approveAllReportsBtn.disabled = false;
            approveAllReportsBtn.innerHTML = original;
        }
    });
    updateApproveAllReportsButton();

    // V70: تُعرَّف قبل renderReports لأنها تُستدعى منه — التعريف كـ const في
    // الأسفل كان يسبب ReferenceError (TDZ) عند أول رسم للشاشة.
    function populateFilterOptions(source = currentReports, provided = null) {
        const campaigns = new Set(), events = new Set();
        if (provided) {
            (provided.campaigns || []).forEach(v => campaigns.add(String(v)));
            (provided.events || []).forEach(v => events.add(String(v)));
        } else {
            (Array.isArray(source) ? source : []).forEach(r => {
                if (r.campaign) campaigns.add(String(r.campaign));
                if (r.event) events.add(String(r.event));
            });
        }
        const rebuild = (select, values) => {
            if (!select) return;
            const prev = select.value;
            select.innerHTML = `<option value="">${select.dataset.label || ''}</option>` +
                [...values].sort().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
            // الخيار السابق قد لا يبقى موجوداً بعد تضييق النطاق على موظف
            // واحد؛ في هذه الحالة نعود إلى «الكل» بدل ترك قيمة لا تطابق أي
            // خيار (ما كان يجعل الفلتر يصفّر النتائج بلا سبب مرئي).
            const stillThere = [...values].some(v => String(v) === prev);
            select.value = stillThere ? prev : '';
        };
        rebuild(historyCampaignFilter, campaigns);
        rebuild(historyEventFilter, events);
    }

    const renderReports = (reportsToRender, options = {}) => {
        reportsAccordion.innerHTML = '';
        if (options.filterOptions) populateFilterOptions(currentReports, options.filterOptions);
        else populateFilterOptions();
        const count = Number.isFinite(Number(options.total)) ? Number(options.total) : (Array.isArray(reportsToRender) ? reportsToRender.length : 0);
        if (reportsCount) reportsCount.textContent = `${count} تقرير${count === 1 ? '' : ''}`;
        if (!reportsToRender || reportsToRender.length === 0) {
            noResultsMessage.textContent = searchInput.value ? 'لا توجد تقارير تطابق بحثك.' : 'لا توجد تقارير محفوظة لعرضها.';
            noResultsMessage.classList.remove('d-none');
            const wrap = document.getElementById('loadMoreReportsWrap');
            if (wrap) wrap.classList.add('d-none');
            return;
        }
        noResultsMessage.classList.add('d-none');
        const list = Array.isArray(reportsToRender) ? reportsToRender : [];
        orderedReports = options.alreadyOrdered ? list.slice() : list.slice().reverse();
        historyLimit = options.keepLimit ? Math.min(historyLimit, orderedReports.length) : HISTORY_PAGE_SIZE;
        renderReportSlice();
        if (options.total !== undefined && reportsCount) reportsCount.textContent = `${count} تقرير`;
    };

    const renderReportSlice = () => {
        reportsAccordion.innerHTML = '';
        const slice = orderedReports.slice(0, historyLimit);
        slice.forEach(report => {
            let grandTotal = 0, totalQuantity = 0;
            const salesRows = report.sales?.length > 0 ? report.sales.map(s => { 
                const p = parseFloat(s.price) || 0;
                const q = parseInt(s.quantity) || 0;
                const t = p * q; 
                grandTotal += t; 
                totalQuantity += q; 
                return `<tr><td>${esc(s.product)||'-'}</td><td>${p.toFixed(2)}</td><td>${q}</td><td>${t.toFixed(2)}</td></tr>`; 
            }).join('') : '<tr><td colspan="4" class="text-center text-muted">لا توجد مبيعات</td></tr>';
            const expensesRows = report.expenses?.length > 0 ? report.expenses.map(exp => `<tr><td>${esc(exp.item)||'-'}</td><td>${esc(exp.quantity)||'0'}</td></tr>`).join('') : '<tr><td colspan="2" class="text-center text-muted">لا توجد مصاريف</td></tr>';
            const competitorSalesRows = report.salesOfCompetitor?.length > 0 ? report.salesOfCompetitor.map(s => `<tr><td>${esc(s.product)||'-'}</td><td>${Number(s.price||0).toFixed(2)}</td><td>${esc(s.quantity)||'0'}</td></tr>`).join('') : '<tr><td colspan="3" class="text-center text-muted">لا توجد مبيعات منافس</td></tr>';
            const promotersList = report.promoters && report.promoters.length > 0 ? report.promoters.map(esc).join(', ') : 'لا يوجد';
            const statusAlertHTML = report.approvalStatus === 'rejected'
            ? `<div class="alert alert-danger py-2 small mb-2"><strong><i class="fa-solid fa-circle-xmark me-1"></i>تم رفض التقرير:</strong> ${esc(report.rejectionReason || 'لا يوجد سبب مذكور')} <span class="text-muted">— بواسطة ${esc(report.rejectionBy || 'غير معروف')}</span></div>`
            : (report.approvalStatus === 'approved'
                ? `<div class="alert alert-success py-2 small mb-2"><strong><i class="fa-solid fa-circle-check me-1"></i>تم اعتماد التقرير:</strong> ${esc(report.approvedBy || 'غير معروف')} <span class="text-muted">— ${esc(report.approvedAt || '')}</span></div>`
                : '');
            const reportHTML = `<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-${esc(report.id)}"><strong>${esc(report.campaign)} - ${esc(report.market)}</strong> (${esc(report.date)}) ${report.approvalStatus === 'approved' ? '<span class="badge bg-success mx-1"><i class="fa-solid fa-circle-check me-1"></i>معتمد</span>' : (report.approvalStatus === 'rejected' ? '<span class="badge bg-danger mx-1"><i class="fa-solid fa-circle-xmark me-1"></i>مرفوض</span>' : (report.approvalStatus ? '<span class="badge bg-warning text-dark mx-1">مسودة</span>' : ''))}</button></h2><div id="c-${esc(report.id)}" class="accordion-collapse collapse" data-bs-parent="#reports-accordion"><div class="accordion-body"><p><strong>تاريخ الإنشاء:</strong> ${esc(report.createdAt) || 'غير مسجل'}</p><p><strong>الحدث:</strong> ${esc(report.event)} (${esc(report.eventDays)} أيام) | <strong>الوقت:</strong> ${esc(report.timeFrom)} - ${esc(report.timeTo)}</p><p><strong>الفريق:</strong> منسق (${esc(report.coordinator) || 'N/A'})، جرد (${esc(report.inventoryDependency) || 'N/A'})، مشرف (${esc(report.supervisor) || 'N/A'})</p><p><strong>المروجون:</strong> ${promotersList}</p><h5 class="mt-4">المبيعات</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead><tbody>${salesRows}</tbody>${report.sales?.length > 0 ? `<tfoot class="table-light fw-bold"><tr><td class="text-end" colspan="2">الإجمالي:</td><td>${totalQuantity}</td><td>${grandTotal.toFixed(2)}</td></tr></tfoot>` : ''}</table><h5 class="mt-4">مبيعات المنافس</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th></tr></thead><tbody>${competitorSalesRows}</tbody></table><h5 class="mt-4">المصاريف</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>الكمية</th></tr></thead><tbody>${expensesRows}</tbody></table>${report.notes ? `<hr><p><strong>ملاحظات:</strong> ${esc(report.notes)}</p>` : ''}<p><strong>تاريخ الإنشاء:</strong> ${esc(report.createdAt) || 'غير مسجل'}${report.editedBy ? ` | <strong>آخر تعديل:</strong> ${esc(report.editedBy)}${report.editedAt ? ` (${esc(report.editedAt)})` : ''}` : ''}${report.latitude && report.longitude ? ` | <a href="https://www.google.com/maps?q=${esc(String(report.latitude) + ',' + String(report.longitude))}" target="_blank" rel="noopener" class="link-primary"><i class="fa-solid fa-location-dot me-1"></i>موقع المحل</a>` : ''}</p>${statusAlertHTML}
            <div class="text-end mt-3 border-top pt-3 d-flex flex-wrap justify-content-end gap-2">
<button type="button" class="btn btn-sm btn-outline-secondary qr-report-btn" data-report-id="${esc(report.id)}" title="رمز QR سريع لتعديل التقرير"><i class="fa-solid fa-qrcode me-1"></i> QR</button>
${(isAdmin || isManager || isAuditor) && String(report.approvalStatus || '').trim() !== 'approved' ? `<button type="button" class="btn btn-sm btn-outline-success approve-report-btn" data-report-id="${esc(report.id)}"><i class="fa-solid fa-check me-1"></i> اعتماد</button>` : ''}
${(isAdmin || isManager || isAuditor) && String(report.approvalStatus || '').trim() !== 'rejected' ? `<button type="button" class="btn btn-sm btn-outline-danger reject-report-btn" data-report-id="${esc(report.id)}"><i class="fa-solid fa-ban me-1"></i> رفض</button>` : ''}
<button type="button" class="btn btn-sm btn-outline-secondary print-report-btn" data-report-id="${esc(report.id)}" title="طباعة أو حفظ التقرير PDF"><i class="fa-solid fa-print me-1"></i> طباعة</button>
<a href="#/reports?edit=${esc(report.id)}" class="btn btn-sm btn-primary edit-report-btn" data-report-id="${esc(report.id)}"><i class="fa-solid fa-pen-to-square me-1"></i> تعديل</a>${isAdmin || isManager || isAuditor ? `<button type="button" class="btn btn-sm btn-outline-danger delete-report-btn" data-report-id="${esc(report.id)}" title="حذف التقرير"><i class="fa-solid fa-trash-can me-1"></i> حذف</button>` : ''}</div></div></div></div>`;
            reportsAccordion.insertAdjacentHTML('beforeend', reportHTML);
        });
        reportsAccordion.querySelectorAll('.edit-report-btn').forEach(button => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                const reportId = button.getAttribute('data-report-id');
                const reportData = currentReports.find(r => r.id == reportId);
                if (reportData) {
                    // المفتاح نفسه الذي تقرؤه شاشة التقارير (page-reports.js) —
                    // أي اسم آخر يجعل التعديل يُفقد بصمت.
                    sessionStorage.setItem(reportToEditKey(), JSON.stringify(reportData));
                }
                // V58: التنقل بين شاشات الـ SPA مع تمرير معرّف التقرير المراد تعديله.
                if (typeof navigateTo === 'function') {
                    window.__spaPendingEditId = reportId;
                    navigateTo('reports');
                } else {
                    window.location.href = button.href;
                }
            });
        });

        // V50: رمز QR سريع لكل تقرير — يفتح رابط التعديل بمسحه من جهاز آخر.
        reportsAccordion.querySelectorAll('.qr-report-btn').forEach(button => {
            button.addEventListener('click', async () => {
                const reportId = button.getAttribute('data-report-id');
                const target = new URL(`./index.html#/reports?edit=${encodeURIComponent(reportId)}`, window.location.href).href;
                const linkInput = document.getElementById('qrEditLink');
                if (linkInput) { linkInput.value = target; linkInput.select(); }
                const wrap = document.getElementById('qrCanvasWrap');
                if (wrap) wrap.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                const modal = new bootstrap.Modal(document.getElementById('qrModal'));
                modal.show();
                const loaded = await loadQrcodeLibrary();
                if (!loaded || typeof QRCode === 'undefined') {
                    if (wrap) wrap.innerHTML = '<div class="alert alert-danger small">تعذر تحميل مكتبة QR — تحقق من الاتصال.</div>';
                    return;
                }
                if (wrap) {
                    wrap.innerHTML = '';
                    const canvas = document.createElement('canvas');
                    wrap.appendChild(canvas);
                    QRCode.toCanvas(canvas, target, { width: 220, margin: 2, color: { dark: '#1e293b', light: '#ffffff' } }, (err) => {
                        if (err && wrap) wrap.innerHTML = '<div class="alert alert-danger small">تعذر إنشاء الرمز.</div>';
                    });
                }
            });
        });

        // V63: اعتماد/رفض التقرير من السجل مباشرة — admin/manager/auditor، مع سبب الرفض.
        const reviewReport = async (button, reportId, status) => {
            const isReject = status === 'rejected';
            let reason = '';
            if (isReject) {
                reason = prompt('أدخل سبب الرفض (سيظهر للموظف صاحب التقرير):');
                if (reason === null) return false;
                if (!String(reason).trim()) { alert('يرجى كتابة سبب الرفض.'); return false; }
                reason = String(reason).trim();
            } else {
                if (!confirm('اعتماد هذا التقرير رسمياً؟ ستُثبَّت الحالة كـ «معتمد».')) return false;
            }
            button.disabled = true;
            const original = button.innerHTML;
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin me-1"></i> ${isReject ? 'جارٍ الرفض...' : 'جارٍ الاعتماد...'}`;
            try {
                const result = await apiPost('approveReport', {
                    id: reportId,
                    role: currentUser.role || '',
                    status,
                    reason,
                    userName: currentUser.name || '',
                    approvedBy: currentUser.name || '',
                    approvedAt: new Date().toISOString()
                });
                if (!result || result.status !== 'success') throw new Error(result?.message || (isReject ? 'فشل الرفض' : 'فشل الاعتماد'));
                invalidateReportsCache();
                const current = currentReports.find(r => r.id == reportId);
                if (current) {
                    current.approvalStatus = status;
                    if (isReject) { current.rejectionReason = reason; current.rejectionBy = currentUser.name || ''; }
                    else { current.approvedBy = currentUser.name || ''; current.approvedAt = new Date().toISOString(); }
                }
                renderReports(currentReports);
                const toastNode = document.querySelector('.toast-message');
                if (toastNode) {
                    toastNode.textContent = isReject ? 'تم رفض التقرير.' : 'تم اعتماد التقرير بنجاح.';
                    toastNode.classList.remove('error');
                    document.querySelector('.toast-container')?.classList.add('show');
                    setTimeout(() => document.querySelector('.toast-container')?.classList.remove('show'), 3000);
                }
                return true;
            } catch (e) {
                button.disabled = false;
                button.innerHTML = original;
                alert(`تعذر ${isReject ? 'رفض' : 'اعتماد'} التقرير: ${e.message || e}\n\nتأكد من نشر النسخة المحدّثة من Apps Script (راجع قسم approveReport في code.gs.txt).`);
                return false;
            }
        };
        reportsAccordion.querySelectorAll('.approve-report-btn').forEach(button => {
            button.addEventListener('click', () => reviewReport(button, button.getAttribute('data-report-id'), 'approved'));
        });
        reportsAccordion.querySelectorAll('.reject-report-btn').forEach(button => {
            button.addEventListener('click', () => reviewReport(button, button.getAttribute('data-report-id'), 'rejected'));
        });

        // V63: طباعة / حفظ تقرير كـ PDF.
        reportsAccordion.querySelectorAll('.print-report-btn').forEach(button => {
            button.addEventListener('click', () => {
                const report = currentReports.find(r => r.id == button.getAttribute('data-report-id'));
                if (report) openReportPrint(report);
            });
        });
        
        // V60: حذف تقرير (soft delete) — مدير/مدقق/مشرف.
        reportsAccordion.querySelectorAll('.delete-report-btn').forEach(button => {
            button.addEventListener('click', async () => {
                const reportId = button.getAttribute('data-report-id');
                if (!confirm('حذف هذا التقرير نهائياً من العرض؟ (يبقى محفوظاً في الجدول للرجوع عنه، ولن يظهر في السجلات بعد الآن.)')) return;
                button.disabled = true;
                const original = button.innerHTML;
                button.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ الحذف...';
                try {
                    const result = await apiPost('deleteReport', {
                        id: reportId,
                        role: currentUser.role || '',
                        userName: currentUser.name || '',
                        userId: String(currentUser.id || '')
                    });
                    if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل الحذف');
                    invalidateReportsCache();
                    currentReports = (currentReports || []).filter(r => String(r.id) !== String(reportId));
                    renderReports(currentReports);
                    const toastNode = document.querySelector('.toast-message');
                    if (toastNode) {
                        toastNode.textContent = 'تم حذف التقرير.';
                        toastNode.classList.remove('error');
                        document.querySelector('.toast-container')?.classList.add('show');
                        setTimeout(() => document.querySelector('.toast-container')?.classList.remove('show'), 3000);
                    }
                } catch (e) {
                    button.disabled = false;
                    button.innerHTML = original;
                    alert(`تعذر حذف التقرير: ${e.message || e}\n\nتأكد من نشر النسخة المحدّثة من Apps Script (راجع قسم deleteReport في code.gs.txt).`);
                }
            });
        });

        const loadMoreWrap = document.getElementById('loadMoreReportsWrap');
        if (loadMoreWrap) {
            const hasMore = historyServerPagedMode ? historyServerHasMore : historyLimit < orderedReports.length;
            loadMoreWrap.classList.toggle('d-none', !hasMore);
        }
        scrollToPendingReport();
    };

    // جلب تقارير من الخادم — targetId = 'all' (النطاق الافتراضي حسب الصلاحية) أو معرّف موظف محدد.
    async function fetchReportsFromServer(targetId) {
        const data = await apiGet('getReports', {
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || ''),
            targetUserId: String(targetId || 'all')
        });
        if (!Array.isArray(data)) throw new Error(data?.message || 'استجابة غير صالحة من الخادم');
        return data;
    }


    async function fetchReportsPageFromServer(targetId, page = 1) {
        const params = {
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || ''),
            targetUserId: String(targetId || 'all'),
            page: String(page),
            pageSize: String(HISTORY_PAGE_SIZE)
        };
        // core.js يمنع تكرار طلب الصفحة نفسها عندما تحدث إعادة زيارة/تحديث سريع.
        const data = await (typeof ajaxGetReportsPage === 'function'
            ? ajaxGetReportsPage(params)
            : apiGet('getReportsPage', params));
        if (!data || data.status !== 'success' || !Array.isArray(data.items)) {
            throw new Error(data?.message || 'استجابة غير صالحة من الخادم');
        }
        return data;
    }

    async function loadHistoryServerPage(reset = false, targetId = selectedTargetId) {
        // يمكن لطلب إعادة الضبط (مثلاً عند تغيير الموظف) أن يبدأ أثناء جلب الصفحة
        // الأولى؛ نُبطل الطلب الأقدم منطقياً، لكن نمنع تكرار طلب «عرض المزيد».
        if (historyServerLoading && !reset) return;
        historyServerLoading = true;
        const requestSeq = ++historyServerRequestSeq;
        try {
            const page = reset ? 1 : historyServerPage + 1;
            const data = await fetchReportsPageFromServer(targetId, page);
            // عند تبديل الموظف بسرعة قد تصل استجابة الطلب السابق بعد الطلب الجديد؛
            // تجاهلها حتى لا تعيد تقارير الموظف السابق إلى الشاشة.
            if (requestSeq !== historyServerRequestSeq || String(targetId || 'all') !== String(selectedTargetId || 'all')) return;
            const incoming = Array.isArray(data.items) ? data.items : [];
            if (reset) currentReports = incoming;
            else currentReports = currentReports.concat(incoming);
            historyServerPage = Number(data.page) || page;
            historyServerHasMore = !!data.hasMore;
            historyServerPagedMode = true;
            historyFilterDataLoaded = false;
            renderReports(currentReports, { alreadyOrdered: true, keepLimit: true, total: data.total, filterOptions: data.filterOptions });
            historyLimit = currentReports.length;
            renderReportSlice();
        } finally {
            if (requestSeq === historyServerRequestSeq) historyServerLoading = false;
        }
    }

    // القائمة المنسدلة لاختيار موظف معيّن — admin يرى الجميع، manager يرى فريقه فقط.
    if (employeeFilterWrap && employeeFilterSelect) {
        const options = await fetchTeamOptions(currentUser);
        if (options.length) {
            teamOptionsByName = new Map(options.map(o => [String(o.id), o.name]));
            employeeFilterSelect.innerHTML = '<option value="all">الكل</option>' +
                options.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
            employeeFilterWrap.classList.remove('d-none');
            employeeFilterSelect.addEventListener('change', async () => {
                selectedTargetId = employeeFilterSelect.value || 'all';
                updateHistoryTitle();
                historyFilterDataLoaded = false;
                reportsAccordion.innerHTML = `<div class="text-center p-4"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
                try {
                    await loadHistoryServerPage(true, selectedTargetId);
                } catch (e) {
                    reportsAccordion.innerHTML = `<div class="alert alert-danger">تعذر تحميل بيانات هذا الموظف.</div>`;
                }
            });
        }
    }

    // V70: كان يقرأ كاش الذاكرة ومفتاح localStorage غير المرتبط بالمستخدم،
    // فيرى أول ما salvéه مستخدم سابق على نفس المتصفح قبل أن يجلب بياناته.
    const warmCache = (typeof getMemoryReportsCache === 'function') ? getMemoryReportsCache() : memoryReportsCache;
    const cachedReportsJSON = warmCache
        ? null
        : ((typeof readLegacyReportsCacheJSON === 'function') ? readLegacyReportsCacheJSON() : localStorage.getItem('reportsCache'));
    if (warmCache) {
        currentReports = warmCache;
        historyServerPagedMode = false;
        renderReports(currentReports);
    } else if (cachedReportsJSON) {
        try {
            const allCachedReports = JSON.parse(cachedReportsJSON);
            if (Array.isArray(allCachedReports)) {
                currentReports = allCachedReports;
                historyServerPagedMode = false;
                renderReports(currentReports);
            }
        } catch (e) {
            localStorage.removeItem('reportsCache');
        }
    }
    // V70: عند امتلاء كاش الذاكرة تكون cachedReportsJSON فارغة عمداً، فكان
    // الشرط التالي يطمس ما رسمناه للتو بالهيكل العظمي، ثم يتخطّى
    // applyReportsIfChanged إعادة الرسم لأن البيانات مطابقة — وتبقى
    // الشاشة فارغة. لا نعرض الهيكل إلا إذا لم يُرسم شيء بعد.
    if (!cachedReportsJSON && !currentReports.length) {
        reportsAccordion.innerHTML = `<div class="p-2"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>`;
    }

    // V63: فلاتر السجل — حملة/حدث/حالة + بحث نصي + بحث برقم التقرير أو الباركود.
    // V70: عناصر الفلاتر انتقلت إلى أعلى الشاشة (انظر أعلى handleHistoryPage).
    const barcodeProducts = new Map();
    let barcodeLoadPromise = null;
    const ensureBarcodeMap = () => {
        if (!barcodeLoadPromise) {
            barcodeLoadPromise = (async () => {
                try {
                    if (typeof getDbData !== 'function') return;
                    const db = await getDbData();
                    const all = Object.values((db && db.products) || {}).flat();
                    all.forEach(p => {
                        const b = String(p.barcode || '').trim();
                        const n = String(p.name || '').trim();
                        if (b && n) {
                            if (!barcodeProducts.has(b)) barcodeProducts.set(b, []);
                            barcodeProducts.get(b).push(n);
                        }
                    });
                } catch (e) { /* بلا اتصال: يتابع البحث الاسمي */ }
            })();
        }
        return barcodeLoadPromise;
    };
    const buildHaystack = (r) => [
        r.campaign || '', r.market || '', r.date || '', r.supervisor || '',
        r.coordinator || '', r.inventoryDependency || '', r.event || '',
        r.notes || '',
        Array.isArray(r.promoters) ? r.promoters.join(' ') : '',
        Array.isArray(r.sales) ? r.sales.map(s => s.product).join(' ') : '',
        Array.isArray(r.salesOfCompetitor) ? r.salesOfCompetitor.map(s => s.product).join(' ') : '',
        Array.isArray(r.expenses) ? r.expenses.map(e => e.item).join(' ') : ''
    ].join(' ').toLowerCase();
    // V70: populateFilterOptions انتقل إلى أعلى الشاشة قبل renderReports.
    const refreshFilteredList = () => {
        historyServerPagedMode = false;
        const term = String(searchInput.value || '').toLowerCase().trim();
        const idTerm = String(historyIdFilter?.value || '').trim().toLowerCase();
        const camp = historyCampaignFilter?.value || '';
        const evnt = historyEventFilter?.value || '';
        const st = historyStatusFilter?.value || '';
        const trimmed = [];
        (Array.isArray(currentReports) ? currentReports : []).forEach(r => {
            if (camp && String(r.campaign || '') !== camp) return;
            if (evnt && String(r.event || '') !== evnt) return;
            if (st === 'approved' && r.approvalStatus !== 'approved') return;
            if (st === 'rejected' && r.approvalStatus !== 'rejected') return;
            if (st === 'pending' && (r.approvalStatus === 'approved' || r.approvalStatus === 'rejected')) return;
            if (idTerm) {
                if (String(r.id || '').toLowerCase().includes(idTerm)) { trimmed.push(r); return; }
                if (/^\d+$/.test(idTerm)) {
                    const names = barcodeProducts.get(idTerm) || [];
                    if (names.length) {
                        const hay = r.__searchText || (r.__searchText = buildHaystack(r));
                        if (names.some(n => hay.includes(n.toLowerCase()))) { trimmed.push(r); return; }
                    }
                }
            }
            if (term) {
                const hay = r.__searchText || (r.__searchText = buildHaystack(r));
                if (!hay.includes(term)) return;
            }
            trimmed.push(r);
        });
        renderReports(trimmed);
    };
    let searchDebounceTimer = null;
    const ensureFullFilterData = async () => {
        if (historyFilterDataLoaded && !historyServerPagedMode) return true;
        const full = await cachedReportsFetch(scopeForAll, { ttlMinutes: 2 });
        currentReports = Array.isArray(full) ? full : [];
        historyFilterDataLoaded = true;
        historyServerPagedMode = false;
        return true;
    };
    const scheduleFilter = () => {
        ensureBarcodeMap();
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(async () => {
            try {
                await ensureFullFilterData();
                refreshFilteredList();
            } catch (e) {
                failedReportsNotice(e?.message || e || 'تعذر تحميل البيانات للبحث');
            }
        }, 150);
    };
    const applySelectFilter = async () => {
        try { await ensureFullFilterData(); refreshFilteredList(); }
        catch (e) { failedReportsNotice(e?.message || e || 'تعذر تحميل البيانات للفلتر'); }
    };
    searchInput.addEventListener('input', scheduleFilter);
    historyIdFilter?.addEventListener('input', scheduleFilter);
    historyCampaignFilter?.addEventListener('change', applySelectFilter);
    historyEventFilter?.addEventListener('change', applySelectFilter);
    historyStatusFilter?.addEventListener('change', applySelectFilter);
    clearHistoryFiltersBtn?.addEventListener('click', async () => {
        if (historyCampaignFilter) historyCampaignFilter.value = '';
        if (historyEventFilter) historyEventFilter.value = '';
        if (historyStatusFilter) historyStatusFilter.value = '';
        if (historyIdFilter) historyIdFilter.value = '';
        searchInput.value = '';
        historyFilterDataLoaded = false;
        try { await loadHistoryServerPage(true, selectedTargetId); }
        catch (e) { failedReportsNotice(e?.message || e || 'تعذر تحميل السجل'); }
    });

    // V59: بدل انتظار الشبكة ثم إعادة بناء كل شيء، نعرض الكاش المخزّن فوراً عبر
    // cachedReportsFetch (stale-while-revalidate) ونحدّث في الخلفية، ولا نعيد الرسم
    // إلا إذا تغيّر المحتوى فعلياً (مقارنة سريعة بالمعرّفات والحالة).
    const scopeForAll = {
        userId: String(currentUser.id || ''),
        role: String(currentUser.role || ''),
        userName: String(currentUser.name || ''),
        targetUserId: 'all'
    };
    const sameReportSet = (a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        const sig = (r) => `${r?.id}|${r?.approvalStatus || ''}`;
        return a.map(sig).join(',') === b.map(sig).join(',');
    };

    // V69: ربط مستمعي إعادة التحميل قبل الجلب الأول — لو فشل الجلب الأول (خطأ عابر أو
    // كاش قديم من سيرفر العمال) يبقى ضغط زر «تحديث البيانات» قادراً على إعادة ملء الشاشة.
    const applyReportsIfChanged = (data) => {
        if (!Array.isArray(data) || selectedTargetId !== 'all' || historyServerPagedMode) return;
        if (!sameReportSet(currentReports, data) || !currentReports.length) {
            currentReports = data;
            renderReports(currentReports);
        }
    };
    const failedReportsNotice = (message) => {
        reportsAccordion.innerHTML = `<div class="alert alert-warning py-2 mb-2 small"><i class="fa-solid fa-triangle-exclamation me-1"></i>تعذر تحميل السجل (${esc(message || '')}). لا توجد بيانات مخزنة لعرضها — اضغط «تحديث البيانات» أو أعد المحاولة.</div>`;
    };
    window.addEventListener('reportsCacheUpdated', (ev) => {
        if (selectedTargetId !== 'all' || !ev.detail || !Array.isArray(ev.detail.data)) return;
        applyReportsIfChanged(ev.detail.data);
    });

    // بعد زر «تحديث البيانات»: نعرض التقارير المحدَّثة من الكاش المنسّق فوراً (دون شبكة إضافية).
    window.addEventListener('appDataRefreshed', async () => {
        try {
            if (historyServerPagedMode) {
                await loadHistoryServerPage(true, selectedTargetId);
                return;
            }
            const fresh = await cachedReportsFetch(scopeForAll);
            applyReportsIfChanged(fresh);
        } catch (e) { /* يبقى الكاش المعروض */ }
    });

    let initialFetchRetries = 0;
    const initialFetchReports = async () => {
        try {
            await loadHistoryServerPage(true, selectedTargetId);
        } catch (e) {
            if (!currentReports.length) failedReportsNotice(e?.message || e || 'خطأ في الاتصال');
            if (initialFetchRetries < 2) {
                initialFetchRetries += 1;
                setTimeout(initialFetchReports, 1500);
            }
        }
    };
    initialFetchReports();

    // V58: عند إعادة زيارة شاشة السجل من قائمة التنقل نُحدّث القائمة من الخادم مع
    // الاكتفاء بالكاش عند غياب الاتصال — دون إعادة بناء الواجهة كاملة.
    window.addEventListener('spaViewRevisited', async (event) => {
        if (event.detail && event.detail.route !== 'history') return;
        try {
            if (historyServerPagedMode) {
                await loadHistoryServerPage(true, selectedTargetId);
            } else {
                const fresh = await cachedReportsFetch(scopeForAll, { force: true });
                if (selectedTargetId === 'all' && !sameReportSet(currentReports, fresh)) {
                    currentReports = fresh;
                    renderReports(currentReports);
                }
            }
        } catch (e) { /* يبقى الكاش المعروض ظاهراً */ }
        // V58: التنقل من التقارير (زر «عرض التقرير») — التمرير يعمل حتى لو كانت الشاشة مبنية
        // أصلاً ولم تتغير البيانات (لا يُعاد تشغيل renderReports).
        setTimeout(scrollToPendingReport, 80);
    });

    const exportHistoryBtn = document.getElementById('exportHistoryCSV');
    exportHistoryBtn?.addEventListener('click', () => {
        if (!currentReports || !currentReports.length) {
            noResultsMessage.textContent = 'لا توجد تقارير لتصديرها.';
            noResultsMessage.classList.remove('d-none');
            return;
        }
        const csv = reportsToCSV(currentReports);
        downloadTextFile(`reports_${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
    });

    const exportHistoryXlsxBtn = document.getElementById('exportHistoryXLSX');
    exportHistoryXlsxBtn?.addEventListener('click', async () => {
        if (!currentReports || !currentReports.length) {
            noResultsMessage.textContent = 'لا توجد تقارير لتصديرها.';
            noResultsMessage.classList.remove('d-none');
            return;
        }
        const XLSX = await loadXlsxLibrary();
        if (!XLSX) {
            alert('تصدير Excel يتطلب اتصالاً بالإنترنت لتحميل مكتبة التحويل أول مرة. يمكنك استخدام «تصدير CSV» دون اتصال.');
            return;
        }
        const flatPromoters = (r) => (Array.isArray(r.promoters) ? r.promoters : []).filter(Boolean).join('، ');
        const aoa = [['رقم التقرير', 'الحملة', 'المحل / المول', 'التاريخ', 'الحدث', 'المشرف', 'المنسق', 'الجرد', 'المروجون', 'الملاحظات', 'المبيعات', 'مبيعات المنافس', 'المصاريف', 'الإجمالي']];
        currentReports.slice().reverse().forEach(r => {
            const sales = (r.sales || []).map(s => `${s.product} (ا${s.quantity}× س${s.price})`).join(' / ');
            const comp = (r.salesOfCompetitor || []).map(s => `${s.product} (ا${s.quantity}× س${s.price})`).join(' / ');
            const expenses = (r.expenses || []).map(e => `${e.item} (${e.quantity})`).join(' / ');
            let grand = 0;
            (r.sales || []).forEach(s => grand += (Number(s.price) || 0) * (Number(s.quantity) || 0));
            aoa.push([r.id, r.campaign, r.market, r.date, r.event, r.supervisor, r.coordinator, r.inventoryDependency, flatPromoters(r), r.notes, sales, comp, expenses, grand.toFixed(2)]);
        });
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = aoa[0].map(() => ({ wch: 18 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'التقارير');
        XLSX.writeFile(wb, `reports_${new Date().toISOString().slice(0,10)}.xlsx`);
    });
}

// V58: تسجيل شاشة سجل التقارير في موجه الـ SPA.
if (typeof registerView === 'function') registerView('history', handleHistoryPage);
