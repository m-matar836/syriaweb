// مستمعات الصفحة تُربط عند كل mount. بدون إلغاء الحزمة السابقة تتراكم المستمعات
// عبر دورات الخروج/الدخول، فيُنفَّذ submitHandler مرتين بنقرة واحدة ويُحفظ
// القرض سجلين لنفس الشخص. الحزمة تُلغي كل مستمعات الـmount السابق دفعة واحدة.
let salaryMountAbort = null;
// حارس أثناء الطلب: يمنع النقر أو Enter المزدوج من إرسال POST ثانٍ متزامن.
let salarySubmitInFlight = false;

// أقصى عدد دفعات للقرض. يجب أن يطابق max في حقل HTML و SALARY_ADVANCE_MAX_INSTALLMENTS
// في Code.gs، وكلاهما مضمون باختبار.
const SALARY_MAX_INSTALLMENTS = 10;

function salaryRequestId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* متصفح قديم */ }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function handleSalaryPage() {
    const view = document.getElementById('view-salary');
    if (!view) return;

    if (salaryMountAbort) salaryMountAbort.abort();
    salaryMountAbort = new AbortController();
    const signal = salaryMountAbort.signal;

    const form = document.getElementById('salaryForm');
    const dateInput = document.getElementById('salDate');
    const employeeSelect = document.getElementById('salEmployee');
    const amountInput = document.getElementById('salAmount');
    const typeSelect = document.getElementById('salType');
    const installmentsInput = document.getElementById('salInstallments');
    const installmentsWrap = document.getElementById('salInstallmentsWrap');
    const notesInput = document.getElementById('salNotes');
    const submitBtn = form?.querySelector('[type="submit"]');
    const historyBody = document.getElementById('salHistoryBody');
    const totalBody = document.getElementById('salTotalBody');
    const notify = (msg, isError = false) => {
        if (typeof window.showToast === 'function') { window.showToast(msg, isError); return; }
        const container = document.getElementById('toast-notification');
        const node = container?.querySelector('.toast-message');
        if (!container || !node) { console[isError ? 'error' : 'log'](msg); return; }
        node.textContent = msg;
        node.classList.toggle('error', isError);
        container.classList.add('show');
        setTimeout(() => container.classList.remove('show'), 3000);
    };

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

    const currentUser = () => {
        try {
            if (typeof getStoredUser === 'function') return getStoredUser();
            return JSON.parse(localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'null');
        } catch (e) { return null; }
    };

    const userSystemRole = () => {
        const user = currentUser() || {};
        const role = String(user.systemRole || user.role || '').trim().toLowerCase();
        return role === 'admin' || role === 'manager' ? role : 'user';
    };

    const isManagerOrAdmin = () => userSystemRole() === 'admin' || userSystemRole() === 'manager';

    // حقل «عدد الدفعات» يخصّ القرض فقط. إخفاؤه مع الأنواع الأخرى يمنع إرسال
    // قيمة لا معنى لها للخادم، ويمنع أيضاً أن يبقى الحقل مفعّلاً بلا سبب.
    function syncInstallmentsVisibility() {
        if (!installmentsWrap) return;
        const isLoan = String(typeSelect?.value || '').trim() === 'loan';
        installmentsWrap.classList.toggle('d-none', !isLoan);
        if (installmentsInput) installmentsInput.required = isLoan;
    }

    // «قرض» و«خصم» صلاحية إدارية: تُقلَّص القائمة لغير المدير/الإداري بدل تعطيل
    // الخيارين، لأن التعطيل يُبقيهما ظاهرين. الخادم يفرض نفس القيد لو استُدعي مباشرة.
    function applyTypePermissions() {
        if (!typeSelect) return;
        if (isManagerOrAdmin()) return;
        typeSelect.innerHTML = '<option value="advance">سلفة</option>';
        typeSelect.value = 'advance';
    }

    async function loadEmployees() {
        if (!employeeSelect) return;
        const canPickEmployee = isManagerOrAdmin();
        employeeSelect.disabled = !canPickEmployee;
        try {
            if (!canPickEmployee) {
                const user = currentUser() || {};
                const selfId = String(user.id || user.username || '').trim();
                const selfName = String(user.name || user.username || 'أنت').trim();
                employeeSelect.innerHTML = `<option value="${esc(selfId)}">${esc(selfName)}</option>`;
                return;
            }
            const result = await apiGet('getTeamOptions', {});
            const employees = Array.isArray(result?.options) ? result.options : [];
            if (!employees.length) {
                employeeSelect.innerHTML = '<option value="">لا يوجد موظفون في فريقك</option>';
                return;
            }
            employeeSelect.innerHTML = '<option value="">اختر الموظف...</option>' +
                employees.map(e => {
                    const value = String(e?.id || '').trim();
                    if (!value) return '';
                    return `<option value="${esc(value)}">${esc(e?.name || value)}</option>`;
                }).join('');
        } catch (e) {
            console.warn('تعذر تحميل الموظفين:', e);
            employeeSelect.innerHTML = '<option value="">تعذر تحميل الموظفين</option>';
        }
    }

    const salaryCacheKey = () => {
        const u = currentUser() || {};
        return `salaryAdvances::${encodeURIComponent(String(u.id || u.username || 'anon'))}`;
    };
    const SALARY_CACHE_TTL_MS = 2 * 60 * 1000;
    let salaryLoadInFlight = null;
    async function loadHistory(force = false) {
        if (!historyBody) return [];
        const key = salaryCacheKey();
        let cached = null, timestamp = 0;
        try {
            const raw = localStorage.getItem(key);
            timestamp = Number(localStorage.getItem(key + ':ts') || 0);
            if (raw) cached = JSON.parse(raw);
        } catch (e) {}
        const hasCache = Array.isArray(cached);
        const isFresh = hasCache && timestamp > 0 && (Date.now() - timestamp) < SALARY_CACHE_TTL_MS;
        if (!force && hasCache) {
            renderHistory(cached);
            if (isFresh || !navigator.onLine) return cached;
        }
        if (salaryLoadInFlight && !force) return salaryLoadInFlight;
        salaryLoadInFlight = (async () => {
            try {
                const result = await apiGet('getSalaryAdvances', {});
                if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر التحميل');
                const rows = Array.isArray(result.advances) ? result.advances : [];
                try {
                    localStorage.setItem(key, JSON.stringify(rows));
                    localStorage.setItem(key + ':ts', String(Date.now()));
                } catch (e) {}
                renderHistory(rows);
                return rows;
            } catch (e) {
                if (hasCache) { renderHistory(cached); return cached; }
                historyBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">${esc(e.message || e)}</td></tr>`;
                return [];
            } finally {
                salaryLoadInFlight = null;
            }
        })();
        return salaryLoadInFlight;
    }

    function renderHistory(advances) {
        if (!historyBody) return;
        if (!advances.length) {
            historyBody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">لا توجد سلف مسجلة بعد.</td></tr>';
            renderTotals([]);
            return;
        }
            historyBody.innerHTML = advances.map(a => {
                const isDeduction = a.type === 'deduction';
                const isLoan = a.type === 'loan';
                const badge = isDeduction
                    ? '<span class="badge bg-danger">خصم</span>'
                    : (isLoan ? '<span class="badge bg-warning text-dark">قرض</span>' : '<span class="badge bg-success">سلفة</span>');
                const installments = Number(a.installments) || 0;
                const installmentsCell = isLoan && installments > 0
                    ? `<span class="badge bg-info text-dark" dir="ltr">${installments}</span>`
                    : '<span class="text-muted">—</span>';
                return `<tr>
                <td>${esc(a.date || '')}</td>
                <td>${esc(a.employeeName || '')}</td>
                <td>${badge}</td>
                <td dir="ltr">${money(a.amount)}</td>
                <td>${installmentsCell}</td>
                <td>${esc(a.notes || '')}</td>
                <td>${esc(a.createdByName || '')}</td>
            </tr>`;
            }).join('');
        renderTotals(advances);
    }

    function renderTotals(advances) {
        if (!totalBody) return;
        const totals = {};
        advances.forEach(a => {
            const name = a.employeeName || 'غير معروف';
            if (!totals[name]) totals[name] = { name, total: 0 };
            const amount = Number(a.amount) || 0;
            totals[name].total += a.type === 'deduction' ? -amount : amount;
        });
        const list = Object.values(totals);
        if (!list.length) {
            totalBody.innerHTML = '<tr><td colspan="2" class="text-center text-muted py-3">لا توجد بيانات.</td></tr>';
            return;
        }
        totalBody.innerHTML = list.map(t => {
            const isNeg = t.total < 0;
            return `<tr>
                <td>${esc(t.name)}</td>
                <td class="${isNeg ? 'text-danger' : 'text-success'} fw-bold" dir="ltr">${money(t.total)}</td>
            </tr>`;
        }).join('');
    }

    async function submitHandler(e) {
        e.preventDefault();
        e.stopPropagation();
        // طلب جارٍ بالفعل: نتجاهل أي submit ثانٍ حتى ينتهي الأول.
        if (salarySubmitInFlight) return;
        if (form && !form.checkValidity()) { form.classList.add('was-validated'); return; }

        const user = currentUser();
        const employeeId = isManagerOrAdmin()
            ? String(employeeSelect?.value || '').trim()
            : String(user?.id || user?.username || '').trim();
        const amount = Number(amountInput?.value);
        let type = String(typeSelect?.value || 'advance').trim();
        // القرض والخصم للمدير/الإداري. القائمة مُقلَّصة أصلاً لمن لا يملك الصلاحية،
        // لكن إعادة الفحص هنا تُبطل أي قيمة تُحقن في العنصر من خارج الصفحة.
        if (!isManagerOrAdmin() && type !== 'advance') type = 'advance';
        const notes = String(notesInput?.value || '').trim();
        const date = String(dateInput?.value || '').trim();
        // الدفعات تُرسل مع القرض فقط؛ الخادم يتجاهلها للأنواع الأخرى.
        const installments = type === 'loan' ? Number(installmentsInput?.value) || 0 : 0;

        if (!employeeId) { notify('اختر الموظف أولاً.', true); return; }
        if (!Number.isFinite(amount) || amount <= 0) { notify('أدخل مبلغاً صحيحاً أكبر من صفر.', true); return; }
        if (type === 'loan' && (!Number.isInteger(installments) || installments < 1 || installments > SALARY_MAX_INSTALLMENTS)) {
            notify(`أدخل عدد دفعات صحيحاً للقرض (من 1 إلى ${SALARY_MAX_INSTALLMENTS}).`, true); return;
        }
        if (!date) { notify('اختر التاريخ أولاً.', true); return; }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جاري الحفظ...'; }
        salarySubmitInFlight = true;
        try {
            const requestId = salaryRequestId();
            const result = await apiPost('saveSalaryAdvance', { employeeId, amount, type, notes, date, installments, requestId });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر الحفظ');
            notify(result.message || 'تم حفظ السلفية بنجاح.');
            try { localStorage.removeItem(salaryCacheKey()); } catch (e) { /* تجاهل فشل التخزين المحلي */ }
            if (isManagerOrAdmin()) form.reset();
            syncInstallmentsVisibility();
            await loadHistory(true);
        } catch (err) {
            notify(`خطأ أثناء الحفظ: ${err.message || err}`, true);
        } finally {
            salarySubmitInFlight = false;
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> حفظ'; }
        }
    }

    form?.addEventListener('submit', submitHandler, { signal });
    typeSelect?.addEventListener('change', syncInstallmentsVisibility, { signal });
    applyTypePermissions();
    syncInstallmentsVisibility();

    const today = new Date();
    if (dateInput && !dateInput.value) {
        dateInput.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    }

    await loadEmployees();
    await loadHistory();

    window.addEventListener('spaViewRevisited', async (event) => {
        if (event?.detail?.route && event.detail.route !== 'salary') return;
        await loadEmployees();
        await loadHistory();
    }, { signal });

    // V72: زر «تحديث البيانات» وتعديل الشيت ينتهيان في نفس الكاش، ولم تكن هذه
    // الشاشة تستمع له — فكانت الصفوف المعروضة ليست بين ما يُحدَّث.
    window.addEventListener('appDataRefreshed', async () => {
        await loadHistory();
    }, { signal });
}

if (typeof registerView === 'function') registerView('salary', handleSalaryPage);
