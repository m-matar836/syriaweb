// ===================================================================
//                  صفحة الخطة الشهرية (لكل منسق)
// ===================================================================
async function handleMonthlyPlanPage() {
    const view = document.getElementById('view-monthly-plan');
    if (!view) return;

    const monthInput = document.getElementById('mpMonthInput');
    const coordSelect = document.getElementById('mpCoordinatorSelect');
    const filterStatusSelect = document.getElementById('mpFilterStatus');
    const loadBtn = document.getElementById('mpLoadBtn');
    const addRowBtn = document.getElementById('mpAddRowBtn');
    const copyPrevBtn = document.getElementById('mpCopyPrevMonthBtn');
    const saveBtn = document.getElementById('mpSaveBtn');
    const tbody = document.getElementById('mpTableBody');
    const statusMsg = document.getElementById('mpStatusMsg');
    const statTotal = document.getElementById('mpStatTotal');
    const statDone = document.getElementById('mpStatDone');
    const statPlanned = document.getElementById('mpStatPlanned');

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&', '<': '<', '>': '>', '"': '"', "'": "'"
    }[ch]));

    const notify = (msg, isErr = false) => {
        if (typeof window.showToast === 'function') { window.showToast(msg, isErr); return; }
        const container = document.getElementById('toast-notification');
        const node = container?.querySelector('.toast-message');
        if (!container || !node) { alert(msg); return; }
        node.textContent = String(msg ?? '');
        node.classList.toggle('error', isErr);
        container.classList.add('show');
        setTimeout(() => container.classList.remove('show'), 3000);
    };

    const currentMonthKey = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    const prevMonthKey = (mKey) => {
        const m = String(mKey || '').match(/^(\d{4})-(\d{2})$/);
        if (!m) return '';
        let y = Number(m[1]), mo = Number(m[2]) - 1;
        if (mo < 1) { mo = 12; y -= 1; }
        return `${y}-${String(mo).padStart(2, '0')}`;
    };

    const hasSelect2 = (el) => {
        const jq = window.jQuery || window.$;
        return Boolean(el && jq && typeof jq(el).select2 === 'function');
    };

    const initRowSelect2 = (el, placeholder = 'ابحث أو اختر...') => {
        const jq = window.jQuery || window.$;
        if (!el || !jq || typeof jq(el).select2 !== 'function') return;
        const $el = jq(el);
        if ($el.hasClass('select2-hidden-accessible')) {
            $el.select2('destroy');
        }
        $el.select2({
            theme: 'bootstrap-5',
            dir: 'rtl',
            placeholder: { id: '', text: placeholder },
            allowClear: false,
            width: '100%',
            dropdownParent: view
        });
    };

    const destroyRowSelect2 = (container) => {
        const jq = window.jQuery || window.$;
        if (!container || !jq) return;
        container.querySelectorAll('select').forEach((sel) => {
            const $sel = jq(sel);
            if ($sel.hasClass('select2-hidden-accessible')) {
                try { $sel.select2('destroy'); } catch (_) {}
            }
        });
    };

    const setSelectValue = (el, val, placeholder = 'ابحث أو اختر...') => {
        if (!el) return;
        const jq = window.jQuery || window.$;
        el.value = val ?? '';
        if (hasSelect2(el)) {
            jq(el).val(el.value).trigger('change.select2');
        } else {
            initRowSelect2(el, placeholder);
        }
    };

    const rebuildSelectOptions = (el, options, selectedVal = '', placeholder = 'ابحث أو اختر...') => {
        if (!el) return;
        const jq = window.jQuery || window.$;
        if (hasSelect2(el)) {
            try { jq(el).select2('destroy'); } catch (_) {}
        }
        const safeVal = String(selectedVal ?? '');
        const parts = [`<option value="">${esc(placeholder)}</option>`];
        for (const opt of options) {
            const v = String(opt ?? '');
            parts.push(`<option value="${esc(v)}" ${v === safeVal ? 'selected' : ''}>${esc(v)}</option>`);
        }
        el.innerHTML = parts.join('');
        el.value = safeVal;
        initRowSelect2(el, placeholder);
    };

    const initAllRowSelects = (tr) => {
        if (!tr) return;
        initRowSelect2(tr.querySelector('.mp-gov'), 'ابحث عن المحافظة...');
        initRowSelect2(tr.querySelector('.mp-reg'), 'ابحث عن المنطقة...');
        initRowSelect2(tr.querySelector('.mp-market'), 'ابحث عن المحل / النقطة...');
        initRowSelect2(tr.querySelector('.mp-campaign'), 'ابحث عن الحملة...');
        initRowSelect2(tr.querySelector('.mp-status'), 'اختر الحالة...');
    };

    if (statusMsg) statusMsg.textContent = 'جاري تحميل بيانات الخطة...';
    let db = null;
    try {
        db = typeof getDbData === 'function' ? await getDbData() : null;
    } catch (err) {
        if (statusMsg) statusMsg.textContent = `تعذر تحميل البيانات الأساسية: ${err.message || err}`;
        return;
    }
    const locations = Array.isArray(db?.locations) ? db.locations : [];
    const employees = Array.isArray(db?.employees) ? db.employees : [];
    const campaigns = Array.isArray(db?.campaigns)
        ? db.campaigns
        : Object.keys(db?.products || {});

    const govs = [...new Set(locations.map(l => String(l.gov ?? '').trim()).filter(Boolean))];
    const regionsForGov = (gov) => [...new Set(locations.filter(l => String(l.gov ?? '').trim() === gov).map(l => String(l.region ?? '').trim()).filter(Boolean))];
    const marketsForRegion = (gov, reg) => [...new Set(locations.filter(l => String(l.gov ?? '').trim() === gov && (!reg || String(l.region ?? '').trim() === reg)).map(l => String(l.market ?? l.name ?? '').trim()).filter(Boolean))];
    const campaignNames = [...new Set(campaigns.map(c => typeof c === 'string' ? c.trim() : String(c?.name ?? c?.campaign ?? '').trim()).filter(Boolean))];

    const positionOf = (employee) => String(employee?.jobPosition ?? employee?.role ?? '').trim();
    const isCoordinatorRole = (employee) => /منسق|مسؤول\s+(?:ال)?منطقة|مسؤول\s+جرد/.test(positionOf(employee));
    const normName = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

    const storedUser = typeof getStoredUser === 'function' ? getStoredUser() : null;
    const myName = String(storedUser?.name || '').trim();
    const myRole = String(storedUser?.systemRole || storedUser?.role || '').trim().toLowerCase();
    const isAdmin = myRole === 'admin';
    const isManager = myRole === 'manager';
    const isRegularUser = !isAdmin && !isManager;

    const buildTeamNames = () => {
        const names = new Set();
        if (myName) names.add(normName(myName));
        if (!isManager && !isAdmin) return names;
        const queue = [normName(myName)];
        const seen = new Set(queue);
        while (queue.length) {
            const current = queue.shift();
            employees.forEach(e => {
                const n = String(e.name || '').trim();
                const nn = normName(n);
                if (!n || seen.has(nn)) return;
                if (normName(e.mgr) === current) {
                    seen.add(nn);
                    names.add(nn);
                    queue.push(nn);
                }
            });
        }
        return names;
    };
    const teamNames = buildTeamNames();

    let coordinatorsList = employees
        .filter(e => isCoordinatorRole(e))
        .map(e => String(e.name ?? '').trim())
        .filter(Boolean);

    if (isAdmin) {
        // كل المنسقين
    } else if (isManager) {
        coordinatorsList = coordinatorsList.filter(name => teamNames.has(normName(name)));
        const me = employees.find(e => normName(e.name) === normName(myName));
        if (me && isCoordinatorRole(me) && !coordinatorsList.some(c => normName(c) === normName(myName))) {
            coordinatorsList.unshift(myName);
        }
    } else {
        coordinatorsList = myName ? [myName] : [];
    }

    const finalCoordinators = [...new Set(coordinatorsList)];

    if (monthInput && !monthInput.value) monthInput.value = currentMonthKey();
    if (coordSelect) {
        if (isRegularUser) {
            coordSelect.innerHTML = myName
                ? `<option value="${esc(myName)}" selected>${esc(myName)}</option>`
                : `<option value="">لا يوجد منسق مرتبط بحسابك</option>`;
            coordSelect.value = myName || '';
            coordSelect.disabled = true;
            coordSelect.title = 'المنسق ثابت على حسابك ولا يمكن تغييره';
        } else {
            coordSelect.disabled = false;
            coordSelect.title = '';
            coordSelect.innerHTML = `<option value="">اختر المنسق...</option>` +
                finalCoordinators.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
            if (myName && finalCoordinators.some(c => normName(c) === normName(myName))) {
                coordSelect.value = finalCoordinators.find(c => normName(c) === normName(myName));
            } else if (finalCoordinators.length === 1) {
                coordSelect.value = finalCoordinators[0];
            }
        }
    }

    let planDirty = false;
    let isBusy = false;
    let loadSequence = 0;
    let activeMonthKey = String(monthInput?.value || '');
    let activeCoordinator = String(coordSelect?.value || '');

    const setPlanBusy = (busy) => {
        isBusy = Boolean(busy);
        if (loadBtn) loadBtn.disabled = isBusy;
        if (saveBtn) saveBtn.disabled = isBusy;
        if (addRowBtn) addRowBtn.disabled = isBusy;
        if (copyPrevBtn) copyPrevBtn.disabled = isBusy;
    };

    const markPlanDirty = () => {
        planDirty = true;
        if (statusMsg && !isBusy) statusMsg.textContent = 'هناك تعديلات غير محفوظة في الخطة.';
    };

    const restoreActiveSelection = () => {
        if (monthInput && activeMonthKey) monthInput.value = activeMonthKey;
        if (coordSelect && activeCoordinator) coordSelect.value = activeCoordinator;
    };

    const confirmReplaceDraft = () => {
        if (!planDirty) return true;
        const accepted = typeof window.confirm === 'function' &&
            window.confirm('هناك تعديلات غير محفوظة. هل تريد تحميل خطة أخرى واستبدالها؟');
        if (!accepted) {
            restoreActiveSelection();
            if (statusMsg) statusMsg.textContent = 'تم الاحتفاظ بتعديلاتك غير المحفوظة.';
        }
        return accepted;
    };

    const clearRows = () => {
        if (!tbody) return;
        Array.from(tbody.querySelectorAll('tr')).forEach(destroyRowSelect2);
        tbody.innerHTML = '';
    };

    const updateStats = () => {
        const rows = Array.from(tbody?.querySelectorAll('tr') || []);
        const total = rows.length;
        const done = rows.filter(r => (r.querySelector('.mp-status')?.value || '') === 'منفّذ').length;
        if (statTotal) statTotal.textContent = String(total);
        if (statDone) statDone.textContent = String(done);
        if (statPlanned) statPlanned.textContent = String(Math.max(0, total - done));
    };

    const applyStatusFilter = () => {
        const f = String(filterStatusSelect?.value || '').trim();
        tbody?.querySelectorAll('tr').forEach(tr => {
            const st = tr.querySelector('.mp-status')?.value || '';
            tr.style.display = (!f || st === f) ? '' : 'none';
        });
    };

    const readRow = (tr) => {
        const jq = window.jQuery || window.$;
        const valOf = (sel) => {
            const el = tr.querySelector(sel);
            if (!el) return '';
            if (hasSelect2(el)) return String(jq(el).val() ?? '').trim();
            return String(el.value ?? '').trim();
        };
        const item = {
            date: valOf('.mp-date'),
            governorate: valOf('.mp-gov'),
            region: valOf('.mp-reg'),
            marketName: valOf('.mp-market'),
            campaign: valOf('.mp-campaign'),
            status: valOf('.mp-status') || 'مخطط',
            notes: valOf('.mp-notes')
        };
        if (tr.__planId !== '' && tr.__planId != null) item.planId = tr.__planId;
        return item;
    };

    const addPlanRow = (item = {}) => {
        if (!tbody) return;
        const tr = document.createElement('tr');
        const pid = Number(item.planId);
        tr.__planId = (Number.isFinite(pid) && pid > 0) ? pid : '';
        const initGov = String(item.governorate || '');
        const initReg = String(item.region || '');
        const initMarket = String(item.marketName || '');
        const initCamp = String(item.campaign || '');
        const initStatus = String(item.status || 'مخطط');
        const initDate = String(item.date || (monthInput?.value ? `${monthInput.value}-01` : ''));

        const regs = regionsForGov(initGov);
        const mkts = marketsForRegion(initGov, initReg);

        tr.innerHTML = `
            <td><input type="date" class="form-control form-control-sm mp-date" value="${esc(initDate)}" required></td>
            <td>
                <select class="form-select form-select-sm mp-gov" required>
                    <option value="">ابحث عن المحافظة...</option>
                    ${govs.map(g => `<option value="${esc(g)}" ${g === initGov ? 'selected' : ''}>${esc(g)}</option>`).join('')}
                </select>
            </td>
            <td>
                <select class="form-select form-select-sm mp-reg" required>
                    <option value="">ابحث عن المنطقة...</option>
                    ${regs.map(r => `<option value="${esc(r)}" ${r === initReg ? 'selected' : ''}>${esc(r)}</option>`).join('')}
                </select>
            </td>
            <td>
                <select class="form-select form-select-sm mp-market" required>
                    <option value="">ابحث عن المحل / النقطة...</option>
                    ${mkts.map(m => `<option value="${esc(m)}" ${m === initMarket ? 'selected' : ''}>${esc(m)}</option>`).join('')}
                </select>
            </td>
            <td>
                <select class="form-select form-select-sm mp-campaign" required>
                    <option value="">ابحث عن الحملة...</option>
                    ${campaignNames.map(name => `<option value="${esc(name)}" ${name === initCamp ? 'selected' : ''}>${esc(name)}</option>`).join('')}
                </select>
            </td>
            <td>
                <select class="form-select form-select-sm mp-status" required>
                    <option value="مخطط" ${initStatus === 'مخطط' ? 'selected' : ''}>مخطط</option>
                    <option value="منفّذ" ${initStatus === 'منفّذ' ? 'selected' : ''}>منفّذ</option>
                    <option value="مؤجل" ${initStatus === 'مؤجل' ? 'selected' : ''}>مؤجل</option>
                </select>
            </td>
            <td><input type="text" class="form-control form-control-sm mp-notes" value="${esc(item.notes || '')}" placeholder="ملاحظة"></td>
            <td class="text-nowrap">
                <button type="button" class="btn btn-sm btn-outline-secondary mp-dup-btn" title="تكرار"><i class="fa-solid fa-clone"></i></button>
                <button type="button" class="btn btn-sm btn-outline-danger mp-del-btn" title="حذف"><i class="fa-solid fa-trash-can"></i></button>
            </td>
        `;

        const govSel = tr.querySelector('.mp-gov');
        const regSel = tr.querySelector('.mp-reg');
        const mktSel = tr.querySelector('.mp-market');
        const campSel = tr.querySelector('.mp-campaign');
        const statusSel = tr.querySelector('.mp-status');

        tbody.appendChild(tr);
        initAllRowSelects(tr);
        setSelectValue(govSel, initGov, 'ابحث عن المحافظة...');
        setSelectValue(regSel, initReg, 'ابحث عن المنطقة...');
        setSelectValue(mktSel, initMarket, 'ابحث عن المحل / النقطة...');
        setSelectValue(campSel, initCamp, 'ابحث عن الحملة...');
        setSelectValue(statusSel, initStatus, 'اختر الحالة...');

        const jq = window.jQuery || window.$;
        const bindSelectChange = (el, handler) => {
            if (!el) return;
            el.addEventListener('change', handler);
            if (jq) jq(el).on('change', handler);
        };

        bindSelectChange(govSel, () => {
            const rList = regionsForGov(govSel.value);
            rebuildSelectOptions(regSel, rList, '', 'ابحث عن المنطقة...');
            rebuildSelectOptions(mktSel, [], '', 'ابحث عن المحل / النقطة...');
            markPlanDirty();
        });

        bindSelectChange(regSel, () => {
            const mList = marketsForRegion(govSel.value, regSel.value);
            rebuildSelectOptions(mktSel, mList, '', 'ابحث عن المحل / النقطة...');
            markPlanDirty();
        });

        bindSelectChange(mktSel, markPlanDirty);
        bindSelectChange(campSel, markPlanDirty);

        bindSelectChange(statusSel, () => {
            updateStats();
            applyStatusFilter();
            markPlanDirty();
        });

        tr.querySelector('.mp-del-btn')?.addEventListener('click', () => {
            destroyRowSelect2(tr);
            tr.remove();
            updateStats();
            markPlanDirty();
        });

        tr.querySelector('.mp-dup-btn')?.addEventListener('click', () => {
            const copy = readRow(tr);
            delete copy.planId;
            addPlanRow(copy);
            updateStats();
            markPlanDirty();
        });

        updateStats();
        applyStatusFilter();
    };

    const loadPlanForSelection = async (overrideMonthKey = null, { force = false, silent = false } = {}) => {
        const mKey = String(overrideMonthKey || monthInput?.value || '').trim();
        const coord = String(coordSelect?.value || '').trim();
        if (!mKey || !coord) {
            if (statusMsg) statusMsg.textContent = 'اختر الشهر والمنسق ثم اضغط تحميل.';
            return false;
        }
        if (!force && !confirmReplaceDraft()) return false;
        const requestId = ++loadSequence;
        setPlanBusy(true);
        if (statusMsg && !silent) statusMsg.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري تحميل الخطة...';
        try {
            const res = await apiGet('getMonthlyPlan', { monthKey: mKey, coordinator: coord });
            if (requestId !== loadSequence) return false;
            if (!res || res.status !== 'success') throw new Error(res?.message || 'تعذر تحميل الخطة');
            clearRows();
            (res.items || []).forEach(it => addPlanRow(it));
            if (!(res.items || []).length) addPlanRow();
            planDirty = false;
            activeMonthKey = mKey;
            activeCoordinator = coord;
            updateStats();
            if (statusMsg) {
                const count = (res.items || []).length;
                statusMsg.textContent = count
                    ? `تم تحميل ${count} سطر للمنسق (${coord}) لشهر ${mKey}.`
                    : `لا توجد خطة محفوظة للمنسق (${coord}) لشهر ${mKey} — يمكنك الإضافة ثم الحفظ.`;
            }
            return true;
        } catch (err) {
            restoreActiveSelection();
            if (statusMsg) statusMsg.textContent = `تعذر التحميل: ${err.message || err}`;
            notify(`خطأ في التحميل: ${err.message || err}`, true);
            return false;
        } finally {
            if (requestId === loadSequence) setPlanBusy(false);
        }
    };

    const savePlanForSelection = async () => {
        const mKey = String(monthInput?.value || '').trim();
        const coord = String(coordSelect?.value || '').trim();
        if (!mKey) { notify('اختر الشهر أولاً.', true); return; }
        if (!coord) { notify('اختر المنسق أولاً.', true); return; }

        const rows = Array.from(tbody?.querySelectorAll('tr') || []);
        const requiredFields = [
            ['.mp-date', 'التاريخ'],
            ['.mp-gov', 'المحافظة'],
            ['.mp-reg', 'المنطقة'],
            ['.mp-market', 'المحل / النقطة'],
            ['.mp-campaign', 'الحملة'],
            ['.mp-status', 'الحالة']
        ];
        for (let i = 0; i < rows.length; i += 1) {
            const missing = requiredFields.filter(([selector]) =>
                !String(rows[i].querySelector(selector)?.value || '').trim());
            if (!missing.length) continue;
            const firstMissing = rows[i].querySelector(missing[0][0]);
            firstMissing?.focus?.();
            firstMissing?.reportValidity?.();
            const message = `السطر ${i + 1}: الحقول المطلوبة هي ${missing.map(([, label]) => label).join('، ')}.`;
            if (statusMsg) statusMsg.textContent = message;
            notify(message, true);
            return;
        }
        const items = rows.map(readRow);

        setPlanBusy(true);
        if (statusMsg) statusMsg.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري حفظ الخطة...';
        try {
            const res = await apiPost('saveMonthlyPlan', {
                monthKey: mKey,
                coordinator: coord,
                items
            });
            if (!res || res.status !== 'success') throw new Error(res?.message || 'تعذر الحفظ');
            planDirty = false;
            activeMonthKey = mKey;
            activeCoordinator = coord;
            notify(`تم حفظ ${res.savedCount} زيارة في شيت ${res.sheetName} للمنسق ${coord}.`);
            await loadPlanForSelection(mKey, { force: true, silent: true });
            if (statusMsg) statusMsg.textContent = `آخر حفظ ناجح: ${res.savedCount} زيارة (${mKey} — ${coord}).`;
        } catch (err) {
            if (statusMsg) statusMsg.textContent = `فشل حفظ الخطة: ${err.message || err}`;
            notify(`فشل حفظ الخطة: ${err.message || err}`, true);
        } finally {
            setPlanBusy(false);
        }
    };

    addRowBtn?.addEventListener('click', () => {
        addPlanRow();
        markPlanDirty();
    });
    loadBtn?.addEventListener('click', () => loadPlanForSelection());
    saveBtn?.addEventListener('click', savePlanForSelection);
    filterStatusSelect?.addEventListener('change', applyStatusFilter);
    coordSelect?.addEventListener('change', () => loadPlanForSelection());
    monthInput?.addEventListener('change', () => loadPlanForSelection());
    tbody?.addEventListener('input', markPlanDirty);
    tbody?.addEventListener('change', markPlanDirty);

    const refreshSelectedPlan = () => {
        if (typeof currentRoute !== 'undefined' && currentRoute !== 'monthly-plan') return;
        if (planDirty) {
            if (statusMsg) statusMsg.textContent = 'تم الحفاظ على تعديلاتك غير المحفوظة؛ احفظها قبل إعادة تحميل الخطة.';
            return;
        }
        loadPlanForSelection(null, { force: true, silent: true });
    };
    window.addEventListener('appDataRefreshed', refreshSelectedPlan);
    window.addEventListener('spaViewRevisited', (event) => {
        if (event?.detail?.route === 'monthly-plan') refreshSelectedPlan();
    });

    copyPrevBtn?.addEventListener('click', async () => {
        const mKey = String(monthInput?.value || '').trim();
        const coord = String(coordSelect?.value || '').trim();
        const prev = prevMonthKey(mKey);
        if (!prev || !coord) { notify('اختر الشهر والمنسق أولاً.', true); return; }
        if (!confirmReplaceDraft()) return;
        setPlanBusy(true);
        try {
            const res = await apiGet('getMonthlyPlan', { monthKey: prev, coordinator: coord });
            if (!res || !Array.isArray(res.items) || !res.items.length) {
                notify(`لا توجد خطة سابقة للمنسق في شهر ${prev}.`, true);
                return;
            }
            clearRows();
            res.items.forEach(it => {
                const dayPart = Number(String(it.date || '').slice(8, 10)) || 1;
                const [year, month] = mKey.split('-').map(Number);
                const lastDay = new Date(year, month, 0).getDate();
                const copiedDay = String(Math.min(dayPart, lastDay)).padStart(2, '0');
                addPlanRow({
                    ...it,
                    planId: '',
                    date: `${mKey}-${copiedDay}`,
                    status: 'مخطط'
                });
            });
            planDirty = true;
            activeMonthKey = mKey;
            activeCoordinator = coord;
            updateStats();
            notify(`تم نسخ ${res.items.length} سطر من شهر ${prev}.`);
        } catch (err) {
            notify(`تعذر النسخ: ${err.message || err}`, true);
        } finally {
            setPlanBusy(false);
        }
    });

    if (coordSelect?.value && monthInput?.value) {
        await loadPlanForSelection();
    } else if (!tbody?.children.length) {
        addPlanRow();
    } else {
        tbody.querySelectorAll('tr').forEach(initAllRowSelects);
    }
}

if (typeof registerView === 'function') {
    registerView('monthly-plan', handleMonthlyPlanPage);
}