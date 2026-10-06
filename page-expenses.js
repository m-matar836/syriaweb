// ===================================================================
//        صفحة مصاريف دمشق وريفها — ورقة (Sheet tab) لكل يوم
//  كل بند يُحفظ في تبويب مصاريف_YYYY-MM-DD داخل Google Sheets.
//  التوقيعات الثلاثة + المحافظة + الحالة في تبويب مصاريف_فهرس.
// ===================================================================

const expDraftKey = () => ownerScopedKey('expensesDraft::v1');
const EXP_FALLBACK_CATEGORIES = ['مستلزمات', 'سيارة', 'طعام', 'مواصلات', 'شحن', 'أخرى'];
const EXP_FORM_CODE_FALLBACK = 'TM-PT-OL.00';
const EXP_STATUS_DRAFT_LABEL = 'مسودة';
const EXP_STATUS_APPROVED_LABEL = 'معتمدة';

async function handleExpensesPage() {
    const view = document.getElementById('view-expenses');
    if (!view) return;

    const form = document.getElementById('expensesForm');
    const dateInput = document.getElementById('expDate');
    const govSelect = document.getElementById('expGovernorate');
    const formNumberInput = document.getElementById('expFormNumber');
    const formCodeInput = document.getElementById('expFormCode');
    const tabNameInput = document.getElementById('expTabName');
    const statusWrap = document.getElementById('expStatusBadgeWrap');
    const dayInfo = document.getElementById('expDayInfo');
    const reloadDayBtn = document.getElementById('expReloadDayBtn');
    const itemsBody = document.getElementById('exp-items-body');
    const grandTotalCell = document.getElementById('expGrandTotal');
    const addRowBtn = document.getElementById('add-exp-row');
    const pickCategoryBtn = document.getElementById('pick-exp-category');
    const clearRowsBtn = document.getElementById('clear-exp-rows');
    const statusSelect = document.getElementById('expStatusSelect');    const enteredByInput = document.getElementById('expEnteredBy');
    const lastEditedInput = document.getElementById('expLastEdited');
    const draftStatus = document.getElementById('expDraftStatus');
    const saveMetaBtn = document.getElementById('expSaveMetaBtn');
    const printBtn = document.getElementById('expPrintBtn');
    const printSheet = document.getElementById('expPrintSheet');
    const prDate = document.getElementById('prDate');
    const prFormNumber = document.getElementById('prFormNumber');
    const prFormCode = document.getElementById('prFormCode');
    const prGovernorate = document.getElementById('prGovernorate');
    const prItemsBody = document.getElementById('prItemsBody');
    const prTotal = document.getElementById('prTotal');
const prStatus = document.getElementById('prStatus');
const prTabName = document.getElementById('prTabName');
const prStamp = document.getElementById('prStamp');
const prTotalWords = document.getElementById('prTotalWords');
const prPrintedAt = document.getElementById('prPrintedAt');
    const adminCard = document.getElementById('expAdminCard');
    const sheetsBody = document.getElementById('expSheetsTableBody');
    const refreshListBtn = document.getElementById('expRefreshListBtn');
    const categoryModalEl = document.getElementById('expCategoryModal');
    const categorySearch = document.getElementById('expCategorySearch');
    const categoryTableBody = document.querySelector('#expCategoryTable tbody');
    const addSelectedCategoriesBtn = document.getElementById('addSelectedExpCategoriesBtn');

    const categoryModal = categoryModalEl ? new bootstrap.Modal(categoryModalEl) : null;

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const notify = (message, isError = false) => {
        if (typeof window.showToast === 'function') { window.showToast(message, isError); return; }
        const container = document.getElementById('toast-notification');
        const node = container?.querySelector('.toast-message');
        if (!container || !node) { console[isError ? 'error' : 'log'](message); return; }
        node.textContent = message;
        node.classList.toggle('error', isError);
        container.classList.add('show');
        setTimeout(() => container.classList.remove('show'), 3000);
    };

    const currentUser = () => {
        try { return JSON.parse(localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'null'); }
        catch (e) { return null; }
    };
    const isAdmin = () => String(currentUser()?.role || '').trim().toLowerCase() === 'admin';
    // الاعتماد متاح للإداري والمدير والمدقق (نفس قاعدة approveExpenses في Code.gs).
    const canApprove = () => ['admin', 'manager', 'auditor'].includes(String(currentUser()?.role || '').trim().toLowerCase());

    // خيار «معتمدة» يقبل الاعتماد، وهو متاح للإداري والمدير والمدقق فقط
    // (نفس قاعدة approveExpenses في Code.gs). لغيرهم نخفي الحقل ونكتفي بالشارة.
    function applyStatusPermissions() {
        if (!statusSelect) return;
        const hint = document.getElementById('expStatusHint');
        if (canApprove()) {
            statusSelect.disabled = false;
            if (hint) hint.textContent = 'تظهر على الورقة المطبوعة تحت البنود.';
            return;
        }
        statusSelect.disabled = true;
        if (hint) hint.textContent = 'الحالة تُدار من «إدارة أوراق المصاريف» لدى الإداري.';
    }

    let categories = EXP_FALLBACK_CATEGORIES.slice();
    let draftTimer = null;
    let restoringDraft = false;

    // ---------- التاريخ ورقم النموذج ----------

    const todayKey = () => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    // نفس منطق Code.gs: expensesFormNumber_‎ → No.YY-MM.00
    const formNumberFor = (dateKey) => {
        const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? 'No.' + m[1].slice(2) + '-' + m[2] + '.00' : '';
    };

    const dateLabel = (dateKey) => {
        const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : (dateKey || '—');
    };

    const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

    // يحوّل ISO القادم من Google Sheets إلى تاريخ/وقت محلي مقروء.
    function formatStamp(iso) {
        const raw = String(iso || '').trim();
        if (!raw) return '—';
        const d = new Date(raw);
        if (isNaN(d.getTime())) return raw;
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function syncHeader() {
        const dateKey = String(dateInput?.value || '').trim();
        formNumberInput.value = formNumberFor(dateKey);
        formCodeInput.value = formCodeInput.dataset.formCode || EXP_FORM_CODE_FALLBACK;
        tabNameInput.value = dateKey ? 'مصاريف_' + dateKey : '';
    }

    // مصدر واحد للحالة: يُحدَّث من الخادم ويُستخدم للشارة والطباعة.
    let currentStatus = EXP_STATUS_DRAFT_LABEL;

    function renderStatus(status) {
        currentStatus = status === EXP_STATUS_APPROVED_LABEL ? EXP_STATUS_APPROVED_LABEL : EXP_STATUS_DRAFT_LABEL;
        if (!statusWrap) return;
        const cls = currentStatus === EXP_STATUS_APPROVED_LABEL ? 'bg-success' : 'bg-secondary';
        statusWrap.innerHTML = `<span class="badge ${cls}">${esc(currentStatus)}</span>`;
    }

    // ---------- جدول البنود ----------

    function readRows() {
        return Array.from(itemsBody?.querySelectorAll('tr') || []).map(tr => ({
            category: String(tr.querySelector('.exp-category')?.value || '').trim(),
            statement: String(tr.querySelector('.exp-statement')?.value || '').trim(),
            quantity: String(tr.querySelector('.exp-quantity')?.value || '').trim(),
            price: String(tr.querySelector('.exp-price')?.value || '').trim()
        }));
    }

    function updateTotals() {
        const total = readRows().reduce((sum, r) => sum + (Number(r.price) || 0), 0);
        if (grandTotalCell) grandTotalCell.textContent = money(total);
    }

    function categoryOptions(selected) {
        return categories
            .map(c => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`)
            .join('');
    }

    function createItemRow(item = {}) {
        const tr = document.createElement('tr');
        // حقول السطر بلا required (السطر الفارغ طبيعي)، فنتحقق منها بأنفسنا
        // حتى لا يمنع المتصفح الإرسال برسالة عامة غير واضحة.
        tr.innerHTML =
            `<td><select class="form-select form-select-sm exp-category">` +
                `<option value="">اختر...</option>${categoryOptions(item.category || '')}` +
            `</select></td>` +
            `<td><input type="text" class="form-control form-control-sm exp-statement" value="${esc(item.statement || '')}" maxlength="500" placeholder="البيان"></td>` +
            `<td><input type="number" class="form-control form-control-sm exp-quantity" value="${item.quantity === undefined || item.quantity === null || item.quantity === '' ? '1' : Number(item.quantity) || 1}" min="1" step="1" inputmode="numeric" placeholder="1" style="width:80px"></td>` +
            `<td><input type="number" class="form-control form-control-sm exp-price" value="${item.price === undefined || item.price === null || item.price === '' ? '' : Number(item.price) || 0}" min="0" step="0.01" inputmode="decimal" placeholder="0"></td>` +
            `<td><button type="button" class="btn btn-sm btn-outline-danger remove-exp-row" title="حذف السطر"><i class="fa-solid fa-trash-can"></i></button></td>`;

        tr.querySelector('.remove-exp-row')?.addEventListener('click', () => {
            tr.remove();
            updateTotals();
            saveDraftSoon();
        });
        tr.querySelector('.exp-price')?.addEventListener('input', () => { updateTotals(); saveDraftSoon(); });
        tr.querySelector('.exp-quantity')?.addEventListener('input', () => { updateTotals(); saveDraftSoon(); });
        tr.querySelector('.exp-statement')?.addEventListener('input', saveDraftSoon);
        tr.querySelector('.exp-category')?.addEventListener('change', saveDraftSoon);

        itemsBody.appendChild(tr);
        updateTotals();
        return tr;
    }

    function setRows(items) {
        if (itemsBody) itemsBody.innerHTML = '';
        (items || []).forEach(it => createItemRow(it));
        if (!(items || []).length) createItemRow();
        updateTotals();
    }

    // ---------- المسودة المحلية ----------

    function draftPayload() {
        return {
            date: String(dateInput?.value || ''),
            governorate: String(govSelect?.value || ''),
            rows: readRows(),
            status: String(statusSelect?.value || EXP_STATUS_DRAFT_LABEL)
        };
    }

    function saveDraft() {
        if (restoringDraft) return;
        try {
            const payload = draftPayload();
            const empty = !payload.rows.length || payload.rows.every(r => !r.category && !r.statement && !r.price);
            if (empty || (!payload.date && !payload.governorate)) { localStorage.removeItem(expDraftKey()); return; }
            localStorage.setItem(expDraftKey(), JSON.stringify(payload));
        } catch (e) { /* الكاش غير متاح */ }
    }

    function saveDraftSoon() {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => {
            saveDraft();
            const payload = draftPayload();
            const hasContent = payload.rows.some(r => r.category || r.statement || r.price);
            if (draftStatus) {
                draftStatus.textContent = hasContent
                    ? `<i class="fa-solid fa-cloud-arrow-up me-1"></i> مسودة محفوظة على هذا الجهاز (${new Date().toLocaleTimeString('en-GB')})`
                    : '';
            }
        }, 600);
    }

    function restoreDraft() {
        let payload = null;
        try { payload = JSON.parse(localStorage.getItem(expDraftKey()) || 'null'); } catch (e) { payload = null; }
        if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) return false;
        restoringDraft = true;
        try {
            if (payload.date) dateInput.value = String(payload.date);
            if (payload.governorate) { govSelect.value = payload.governorate; }
            // الخادم هو مصدر الحقيقة للحالة؛ نعرض المسودة مؤقتاً ثم يثبّتها loadDay.
            if (statusSelect && payload.status && !statusSelect.disabled) statusSelect.value = payload.status;
            renderStatus(statusSelect?.disabled ? currentStatus : (payload.status || currentStatus));
            setRows(payload.rows);
            syncHeader();
            return true;
        } finally {
            restoringDraft = false;
        }
    }

    // ---------- المحافظات والفئات ----------

    async function loadOptions() {
        try {
            const result = await apiGet('getExpensesOptions', {});
            if (result?.status === 'success' && Array.isArray(result.categories) && result.categories.length) {
                categories = result.categories;
                if (result.formCode) {
                    formCodeInput.dataset.formCode = result.formCode;
                    formCodeInput.value = result.formCode;
                }
            }
        } catch (e) {
            console.warn('تعذر تحميل فئات المصاريف:', e);
        }
        try {
            const db = typeof getDbData === 'function' ? await getDbData() : null;
            const locations = Array.isArray(db?.locations) ? db.locations : [];
            const govs = [...new Set(locations.map(l => String(l.gov ?? '').trim()).filter(Boolean))];
            if (govSelect) {
                const current = String(govSelect.value || '');
                govSelect.innerHTML = '<option value="" selected disabled>اختر...</option>' +
                    govs.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
                if (current && govs.includes(current)) govSelect.value = current;
            }
        } catch (e) {
            console.warn('تعذر تحميل المحافظات:', e);
        }
    }

    // ---------- تحميل يوم من الخادم ----------

    async function loadDay(silent) {
        const date = String(dateInput?.value || '').trim();
        syncHeader();
        if (!date) { setDayInfo(''); return; }
        if (!silent) setDayInfo('<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري تحميل الورقة...');
        try {
            const result = await apiGet('getExpensesByDate', { date });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر التحميل');
            if (String(dateInput.value) !== date) return;
            const status = result.meta?.status === EXP_STATUS_APPROVED_LABEL ? EXP_STATUS_APPROVED_LABEL : EXP_STATUS_DRAFT_LABEL;
            renderStatus(status);
            // الحقل معطَّل لغير المخوَّلين، فنُبقي قيمته السابقة ولا نُظهر خاطئاً.
            if (statusSelect && !statusSelect.disabled) statusSelect.value = status;
            if (enteredByInput) enteredByInput.value = result.meta?.lastEditedBy || '';
            if (lastEditedInput) lastEditedInput.value = formatStamp(result.meta?.lastEditedAt);
            if (result.exists) {
                setRows(result.items);
                if (govSelect && result.meta?.governorate) govSelect.value = result.meta.governorate;
                setDayInfo(
                    `الورقة <code>${esc(result.dateKey)}</code> تحتوي <b>${result.items.length}</b> بند بإجمالي <b>${money(result.total)}</b>` +
                    (result.meta?.lastEditedBy ? ` — آخر تعديل: ${esc(result.meta.lastEditedBy)}` : '')
                );
            } else {
                setRows([]);
                setDayInfo(`لا توجد ورقة لتاريخ <b>${esc(dateLabel(date))}</b> — ستُنشأ تلقائياً عند أول حفظ.`);
            }
        } catch (e) {
            setDayInfo(`<span class="text-danger">${esc(e.message || e)}</span>`);
        }
    }

    function setDayInfo(html) {
        if (dayInfo) dayInfo.innerHTML = html || '';
    }

    // ---------- الحفظ ----------

    function setFormBusy(busy) {
        const submit = form?.querySelector('[type="submit"]');
        if (submit) { submit.disabled = busy; submit.innerHTML = busy ? '<i class="fa-solid fa-spinner fa-spin"></i> جاري الحفظ...' : '<i class="fa-solid fa-paper-plane"></i> حفظ البنود'; }
        if (saveMetaBtn) saveMetaBtn.disabled = busy;
        [addRowBtn, pickCategoryBtn, clearRowsBtn].forEach(b => { if (b) b.disabled = busy; });
    }

    async function submitHandler(e) {
        e.preventDefault();
        e.stopPropagation();
        if (form && !form.checkValidity()) { form.classList.add('was-validated'); return; }

        const date = String(dateInput?.value || '').trim();
        const governorate = String(govSelect?.value || '').trim();
        const rows = readRows();
        const items = rows
            .filter(r => r.category && r.statement && r.price !== '' && isFinite(Number(r.price)) && Number(r.price) >= 0)
            .map(r => ({ category: r.category, statement: r.statement, price: Number(r.price) }));
        if (!items.length) { notify('أضف بنداً واحداً على الأقل (المادة + البيان + السعر).', true); return; }
        const skipped = rows.length - items.length;
        if (skipped > 0) {
            notify(`سيتم تجاهل ${skipped} سطر ناقص (المادة/البيان/السعر). أكمله أو احذفه ثم أعد الحفظ.`, true);
        }

        setFormBusy(true);
        try {
            const result = await apiPost('submitExpenses', {
                date,
                governorate,
                items,
                status: statusSelect?.value || EXP_STATUS_DRAFT_LABEL
            });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر الحفظ');
            localStorage.removeItem(expDraftKey());
            if (draftStatus) draftStatus.textContent = '';
            notify(`تم حفظ ${result.added} بند في الورقة ${result.tabName} — الإجمالي ${money(result.total)}`);
            await loadDay(true);
            await loadSheetsList();
        } catch (err) {
            notify(`خطأ أثناء الحفظ: ${err.message || err}`, true);
        } finally {
            setFormBusy(false);
        }
    }

    async function saveMetaHandler() {
        const date = String(dateInput?.value || '').trim();
        if (!date) { notify('اختر التاريخ أولاً.', true); return; }
        if (!govSelect?.value) { notify('اختر المحافظة أولاً.', true); return; }
        setFormBusy(true);
        try {
            const result = await apiPost('saveExpensesMeta', {
                date,
                governorate: govSelect.value,
                status: statusSelect?.value || EXP_STATUS_DRAFT_LABEL
            });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر الحفظ');
            notify('تم حفظ بيانات الورقة.');
            localStorage.removeItem(expDraftKey());
            if (draftStatus) draftStatus.textContent = '';
            await loadDay(true);
        } catch (err) {
            notify(`خطأ أثناء الحفظ: ${err.message || err}`, true);
        } finally {
            setFormBusy(false);
        }
    }

    // ---------- إدارة الأوراق (أدمن) ----------

    async function loadSheetsList() {
        if (!isAdmin() || !sheetsBody) return;
        sheetsBody.innerHTML = '<tr><td colspan="7" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>';
        try {
            const result = await apiGet('getExpensesList', {});
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر التحميل');
            renderSheetsList(Array.isArray(result.days) ? result.days : []);
        } catch (e) {
            sheetsBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">${esc(e.message || e)}</td></tr>`;
        }
    }

    function renderSheetsList(days) {
        if (!sheetsBody) return;
        if (!days.length) {
            sheetsBody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">لا توجد أوراق مصاريف بعد.</td></tr>';
            return;
        }
        sheetsBody.innerHTML = days.map(d => {
            const approved = d.status === EXP_STATUS_APPROVED_LABEL;
            const badge = approved ? '<span class="badge bg-success">معتمدة</span>' : '<span class="badge bg-secondary">مسودة</span>';
            const approveBtn = approved ? '' :
                `<button type="button" class="btn btn-sm btn-outline-success approve-exp-sheet" data-date="${esc(d.dateKey)}" title="اعتماد الورقة"><i class="fa-solid fa-check"></i></button>`;
            return `<tr>
                <td><b>${esc(dateLabel(d.dateKey))}</b><div class="small text-muted" dir="ltr">${esc(d.tabName)}</div></td>
                <td>${esc(d.governorate || '—')}</td>
                <td dir="ltr">${esc(d.formNumber || '—')}</td>
                <td>${d.count}</td>
                <td>${money(d.total)}</td>
                <td>${badge}</td>
                <td class="text-nowrap">
                    <button type="button" class="btn btn-sm btn-outline-primary open-exp-sheet" data-date="${esc(d.dateKey)}" title="فتح الورقة"><i class="fa-solid fa-eye"></i></button>
                    ${approveBtn}
                    <button type="button" class="btn btn-sm btn-outline-danger delete-exp-sheet" data-date="${esc(d.dateKey)}" title="حذف الورقة"><i class="fa-solid fa-trash-can"></i></button>
                </td>
            </tr>`;
        }).join('');

        sheetsBody.querySelectorAll('.open-exp-sheet').forEach(btn => {
            btn.addEventListener('click', () => {
                dateInput.value = btn.dataset.date;
                syncHeader();
                loadDay();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
        sheetsBody.querySelectorAll('.delete-exp-sheet').forEach(btn => {
            btn.addEventListener('click', () => deleteSheetHandler(btn.dataset.date));
        });
        sheetsBody.querySelectorAll('.approve-exp-sheet').forEach(btn => {
            btn.addEventListener('click', () => approveSheetHandler(btn.dataset.date));
        });
    }

    async function deleteSheetHandler(dateKey) {
        if (!window.confirm(`سيتم حذف ورقة «${dateKey}» وكل بنودها نهائياً. أي إدخال لاحق بنفس اليوم سينشئ ورقة جديدة.\nهل تريد المتابعة؟`)) return;
        try {
            const result = await apiPost('deleteExpensesSheet', { date: dateKey });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر الحذف');
            notify(result.message || 'تم حذف الورقة.');
            await loadSheetsList();
            await loadDay(true);
        } catch (e) {
            notify(`تعذر الحذف: ${e.message || e}`, true);
        }
    }

    async function approveSheetHandler(dateKey) {
        try {
            const result = await apiPost('approveExpenses', { date: dateKey });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر الاعتماد');
            notify(result.message || 'تم اعتماد الورقة.');
            await loadSheetsList();
            await loadDay(true);
        } catch (e) {
            notify(`تعذر الاعتماد: ${e.message || e}`, true);
        }
    }

    // ---------- الطباعة ----------

    // تحويل رقم إلى كلمات عربية (حتى 999,999,999) — توقيع مالي للأوراق.
    function amountInArabicWords(value) {
        const n = Math.floor(Math.abs(Number(value) || 0));
        if (!n) return 'صفر';
        const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
            'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
        const tens = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
        const hundreds = ['', 'مئة', 'مئتان', 'ثلاث مئة', 'أربع مئة', 'خمس مئة', 'ست مئة', 'سبع مئة', 'ثماني مئة', 'تسع مئة'];

        const underThousand = (num) => {
            const words = [];
            const h = Math.floor(num / 100);
            const rest = num % 100;
            if (h) words.push(hundreds[h]);
            if (rest) {
                if (rest < 20) words.push(ones[rest]);
                else {
                    const o = rest % 10;
                    const t = Math.floor(rest / 10);
                    words.push(o && t ? ones[o] + ' و' + tens[t] : (tens[t] || ones[o]));
                }
            }
            return words.join(' و');
        };

        const scalePhrase = (chunk, singular, dual, plural) => {
            if (chunk === 1) return singular;
            if (chunk === 2) return dual;
            if (chunk >= 3 && chunk <= 10) return underThousand(chunk) + ' ' + plural;
            return underThousand(chunk) + ' ' + singular;
        };

        const parts = [];
        const billions = Math.floor(n / 1000000000);
        const millions = Math.floor(n / 1000000) % 1000;
        const thousands = Math.floor(n / 1000) % 1000;
        const rest = n % 1000;

        if (billions) parts.push(scalePhrase(billions, 'مليار', 'ملياران', 'مليارات'));
        if (millions) parts.push(scalePhrase(millions, 'مليون', 'مليونان', 'ملايين'));
        if (thousands) parts.push(scalePhrase(thousands, 'ألف', 'ألفان', 'آلاف'));
        if (rest) parts.push(underThousand(rest));

        return parts.join(' و');
    }

    function printHandler() {
        const rows = readRows().filter(r => r.category || r.statement || r.price !== '');
        if (!rows.length) {
            notify('لا توجد بنود لطباعتها. أضف بنوداً أولاً.', true);
            return;
        }
        const dateKey = String(dateInput?.value || '').trim();
        const total = rows.reduce((s, r) => s + (Number(r.price) || 0), 0);
        const w = window.open('', '_blank', 'width=900,height=700');
        if (!w) { alert('اسمح بالنوافذ المنبثقة لهذا الموقع لطباعة ورقة المصاريف.'); return; }
        const esc2 = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const lastIndexOfCategory = new Map();
        rows.forEach((r, i) => { lastIndexOfCategory.set(r.category, i); });
        const itemsHtml = rows.map((r, i) => {
            const isGroupLast = lastIndexOfCategory.get(r.category) === i;
            return `<tr>
                <td class="exp-print-num">${i + 1}</td>
                <td class="exp-print-cat${isGroupLast ? ' exp-print-group-last' : ''}">${esc2(r.category)}</td>
                <td class="exp-print-item">${esc2(r.statement)}</td>
                <td class="exp-print-qty">${esc2(r.quantity || '1')}</td>
                <td class="exp-print-price">${r.price === '' ? '' : money(r.price)}</td>
            </tr>`;
        }).join('');
        w.document.open();
        w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ورقة مصاريف ${esc2(dateLabel(dateKey))}</title><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif; color: #1e293b; margin: 30px; line-height: 1.6; background: #fff; }
        .exp-print-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 20px 24px; margin-bottom: 16px; border-radius: 10px; }
        .exp-print-title { font-size: 22pt; font-weight: 800; }
        .exp-print-subtitle { margin-top: 4px; font-size: 10pt; color: rgba(255,255,255,0.8); }
        .exp-print-stamp { flex-shrink: 0; border: 2px solid #ffd700; border-radius: 8px; padding: 8px 18px; font-weight: 800; font-size: 12pt; color: #ffd700; transform: rotate(-4deg); background: rgba(255,215,0,0.15); }
        .exp-print-stamp-approved { border-color: #28a745; color: #28a745; background: rgba(40,167,69,0.12); }
        .exp-print-meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
        .exp-print-field { padding: 10px 14px; background: #f8f9ff; border-radius: 8px; border-left: 4px solid #667eea; }
        .exp-print-label { display: block; font-size: 8pt; color: #666; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
        .exp-print-value { display: block; font-weight: 700; font-size: 11pt; color: #1e293b; }
        .exp-print-table { width: 100%; border-collapse: collapse; table-layout: fixed; border: 2px solid #667eea; border-radius: 8px; overflow: hidden; }
        .exp-print-table th, .exp-print-table td { border: 1px solid #e0e0e0; padding: 8px 10px; vertical-align: middle; }
        .exp-print-table thead th { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; font-size: 10pt; font-weight: 700; text-align: center; text-transform: uppercase; letter-spacing: 0.5px; border: none; padding: 10px; }
        .exp-print-col-num { width: 5%; text-align: center; }
        .exp-print-col-cat { width: 20%; }
        .exp-print-col-item { width: 40%; }
        .exp-print-col-qty { width: 10%; text-align: center; }
        .exp-print-col-price { width: 25%; text-align: left; }
        .exp-print-table td.exp-print-num { text-align: center; color: #888; font-weight: 600; font-size: 9pt; }
        .exp-print-table td.exp-print-cat { font-weight: 700; color: #667eea; background: #f8f9ff; }
        .exp-print-table td.exp-print-item { color: #333; line-height: 1.6; }
        .exp-print-table td.exp-print-qty { text-align: center; font-weight: 600; color: #555; background: #f0f0ff; }
        .exp-print-table td.exp-print-price { text-align: left; font-variant-numeric: tabular-nums; font-weight: 700; color: #1e293b; font-size: 10pt; }
        .exp-print-table tbody tr:nth-child(even) td { background: #fafaff; }
        .exp-print-table tbody tr:nth-child(even) td.exp-print-cat { background: #f0f0ff; }
        .exp-print-table tbody tr:nth-child(even) td.exp-print-qty { background: #e8e8ff; }
        .exp-print-table tr.exp-print-group-last td { border-bottom: 2px solid #667eea; }
        .exp-print-table tbody tr:last-child td { border-bottom: 2px solid #667eea; }
        .exp-print-total-row { display: flex; align-items: baseline; gap: 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 12px 16px; margin-top: 14px; border-radius: 8px; }
        .exp-print-total-label { font-weight: 800; font-size: 12pt; }
        .exp-print-total-words { flex: 1; font-size: 9.5pt; color: rgba(255,255,255,0.85); }
        .exp-print-total-value { font-weight: 800; font-size: 14pt; font-variant-numeric: tabular-nums; color: #ffd700; }
        @media print { body { margin: 12mm; } }
        </style></head><body>
        <div class="exp-print-header">
            <div>
                <div class="exp-print-title">ورقة مصاريف</div>
                <div class="exp-print-subtitle">دمشق وريف دمشق — إدارة الترويج</div>
            </div>
            <div class="exp-print-stamp ${currentStatus === EXP_STATUS_APPROVED_LABEL ? 'exp-print-stamp-approved' : ''}">${esc2(currentStatus)}</div>
        </div>
        <div class="exp-print-meta-grid">
            <div class="exp-print-field"><span class="exp-print-label">التاريخ</span><span class="exp-print-value">${esc2(dateLabel(dateKey))}</span></div>
            <div class="exp-print-field"><span class="exp-print-label">المحافظة</span><span class="exp-print-value">${esc2(govSelect?.value || '—')}</span></div>
            <div class="exp-print-field"><span class="exp-print-label">رقم النموذج</span><span class="exp-print-value" dir="ltr">${esc2(formNumberFor(dateKey))}</span></div>
            <div class="exp-print-field"><span class="exp-print-label">كود النموذج</span><span class="exp-print-value" dir="ltr">${esc2(formCodeInput?.value || EXP_FORM_CODE_FALLBACK)}</span></div>
        </div>
        <table class="exp-print-table">
            <thead><tr><th class="exp-print-col-num">#</th><th class="exp-print-col-cat">المادة</th><th class="exp-print-col-item">البيان</th><th class="exp-print-col-qty">الكمية</th><th class="exp-print-col-price">السعر</th></tr></thead>
            <tbody>${itemsHtml}</tbody>
        </table>
        <div class="exp-print-total-row">
            <span class="exp-print-total-label">الإجمالي</span>
            <span class="exp-print-total-words">${esc2(amountInArabicWords(total))} ل.س</span>
            <span class="exp-print-total-value">${esc2(money(total))}</span>
        </div>
        </body></html>`);
        w.document.close();
        w.focus();
        setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
    }

    // ---------- نافذة اختيار المواد ----------

    function renderCategoryModal() {
        if (!categoryTableBody) return;
        const q = String(categorySearch?.value || '').trim().toLowerCase();
        const list = categories.filter(c => !q || String(c).toLowerCase().includes(q));
        if (!list.length) {
            categoryTableBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-3">لا توجد مواد مطابقة.</td></tr>';
            return;
        }
        categoryTableBody.innerHTML = list.map(c => `<tr>
            <td><div class="form-check"><input class="form-check-input exp-category-check" type="checkbox" value="${esc(c)}"></div></td>
            <td>${esc(c)}</td>
            <td style="width:110px;"><input type="number" class="form-control form-control-sm exp-category-qty" value="1" min="1" step="1"></td>
        </tr>`).join('');
    }

    categorySearch?.addEventListener('input', renderCategoryModal);
    pickCategoryBtn?.addEventListener('click', () => {
        renderCategoryModal();
        categoryModal?.show();
    });
    addSelectedCategoriesBtn?.addEventListener('click', () => {
        const checked = Array.from(categoryTableBody?.querySelectorAll('.exp-category-check:checked') || []);
        if (!checked.length) { notify('حدد مادة واحدة على الأقل.', true); return; }
        // لا تبقِ سطراً فارغاً إن كان الجدول يحتوي سطراً واحداً فارغاً فقط.
        const current = readRows();
        if (current.length === 1 && !current[0].category && !current[0].statement && !current[0].price) {
            itemsBody.innerHTML = '';
        }
        checked.forEach(cb => {
            const qty = Math.max(1, parseInt(cb.closest('tr')?.querySelector('.exp-category-qty')?.value, 10) || 1);
            for (let i = 0; i < qty; i++) createItemRow({ category: cb.value });
        });
        updateTotals();
        saveDraftSoon();
        categoryModal?.hide();
    });
    if (categoryTableBody) {
        categoryTableBody.addEventListener('click', e => {
            if (e.target.closest('input, label, button')) return;
            const cb = e.target.closest('tr')?.querySelector('.exp-category-check');
            if (cb) cb.checked = !cb.checked;
        });
    }

    // ---------- الربط ----------

    addRowBtn?.addEventListener('click', () => {
        const rows = readRows();
        if (rows.length === 1 && !rows[0].category && !rows[0].statement && !rows[0].price) itemsBody.innerHTML = '';
        createItemRow();
    });
    clearRowsBtn?.addEventListener('click', () => {
        if (readRows().some(r => r.category || r.statement || r.price)) {
            if (!window.confirm('سيتم تفريغ جدول البنود (لن يُحذف شيء من Google Sheets). المتابعة؟')) return;
        }
        setRows([]);
        saveDraftSoon();
    });
    dateInput?.addEventListener('change', () => { syncHeader(); loadDay(); });
    reloadDayBtn?.addEventListener('click', () => loadDay());
    govSelect?.addEventListener('change', saveDraftSoon);
    statusSelect?.addEventListener('change', () => { renderStatus(statusSelect.value); saveDraftSoon(); });
    form?.addEventListener('submit', submitHandler);
    saveMetaBtn?.addEventListener('click', saveMetaHandler);
    printBtn?.addEventListener('click', printHandler);
    refreshListBtn?.addEventListener('click', loadSheetsList);

    // العودة إلى الصفحة بعد التنقّل: حدّث قائمة الأوراق للمدير فقط.
    // (المُنشِّط يعمل مرة واحدة لكل جلسة، فتسجيل المستمع كافٍ.)
    if (isAdmin()) window.addEventListener('spaViewRevisited', loadSheetsList);

    // V72: تعديل الشيت وزر «تحديث البيانات» ينتهيان في نفس الكاش، وقبل V72 لم
    // تكن هذه الشاشة تستمع لهما — فكان الكاش يُحدَّث وهذه الشاشة لا تعرضه.
    // اليوم المعروض يُعاد تحميله فقط إن لم توجد مسودة مكتوبة: setRows تمسح
    // ما كتبه المستخدم، والتحديث التلقائي يجب ألّا يمسح عملاً غير محفوظ.
    window.addEventListener('appDataRefreshed', async () => {
        if (isAdmin()) await loadSheetsList();
        let hasDraft = false;
        try {
            const raw = localStorage.getItem(expDraftKey());
            const draft = raw ? JSON.parse(raw) : null;
            hasDraft = !!(draft && Array.isArray(draft.rows)
                && draft.rows.some(r => r.category || r.statement || r.price));
        } catch (e) { hasDraft = false; }
        if (!hasDraft) await loadDay(true);
    });

    if (adminCard) adminCard.style.display = isAdmin() ? '' : 'none';
    applyStatusPermissions();

    await loadOptions();
    if (!dateInput.value) dateInput.value = todayKey();
    if (!restoreDraft()) setRows([]);
    syncHeader();
    await loadDay(true);
    if (isAdmin()) await loadSheetsList();
}

if (typeof registerView === 'function') registerView('expenses', handleExpensesPage);
