//     V27: تحميل مكتبات خارجية ثقيلة عند الحاجة فقط (Lazy Loading)
// ===================================================================
const HTML5_QRCODE_SRC = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
let html5QrcodeLoadPromise = null;
function loadHtml5QrcodeLibrary() {
    if (typeof Html5Qrcode !== 'undefined') return Promise.resolve(true);
    if (html5QrcodeLoadPromise) return html5QrcodeLoadPromise;
    html5QrcodeLoadPromise = new Promise((resolve) => {
        const existing = document.querySelector(`script[src="${HTML5_QRCODE_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve(true));
            existing.addEventListener('error', () => resolve(false));
            return;
        }
        const script = document.createElement('script');
        script.src = HTML5_QRCODE_SRC;
        script.async = true;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
    });
    return html5QrcodeLoadPromise;
}

// ===================================================================
//                 إضافة بيانات جديدة إلى Locations
// ===================================================================
async function addLocationToSheet(type, value, governorate = '', region = '') {
    const cleanValue = String(value ?? '').trim();
    if (!cleanValue) throw new Error('يرجى إدخال القيمة الجديدة.');
    if (!navigator.onLine) throw new Error('إضافة بيانات جديدة تحتاج إلى اتصال بالإنترنت.');

    const result = await apiPost('addLocation', {
        type,
        value: cleanValue,
        governorate: String(governorate ?? '').trim(),
        region: String(region ?? '').trim()
    });
    if (!result || result.status !== 'success') {
        throw new Error(result?.message || 'تعذر إضافة البيانات إلى Locations');
    }
    return result;
}

function setupLocationAddButtons(DBRef) {
    const modalEl = document.getElementById('addLocationModal');
    const form = document.getElementById('addLocationForm');
    if (!modalEl || !form) return;
    const modal = new bootstrap.Modal(modalEl);
    const typeInput = document.getElementById('addLocationType');
    const valueInput = document.getElementById('addLocationValue');
    const contextHint = document.getElementById('addLocationContext');
    const saveBtn = document.getElementById('saveLocationBtn');
    const governorateSelect = document.getElementById('governorate');
    const regionSelect = document.getElementById('region');
    const marketSelect = document.getElementById('market_name');

    const labels = { governorate: 'المحافظة', region: 'المنطقة', market: 'اسم المحل' };

    document.querySelectorAll('[data-add-location]').forEach(btn => {
        if (btn.dataset.locationAddBound === '1') return;
        btn.dataset.locationAddBound = '1';
        btn.addEventListener('click', () => {
            const type = btn.dataset.addLocation;
            const gov = governorateSelect?.value || '';
            const region = regionSelect?.value || '';
            if (type === 'region' && !gov) {
                alert('اختر المحافظة أولاً ثم أضف المنطقة.');
                return;
            }
            if (type === 'market' && (!gov || !region)) {
                alert('اختر المحافظة والمنطقة أولاً ثم أضف اسم المحل.');
                return;
            }
            typeInput.value = type;
            valueInput.value = '';
            valueInput.placeholder = `أدخل ${labels[type] || 'البيانات'} الجديدة`;
            contextHint.textContent = type === 'governorate'
                ? 'ستتم إضافة محافظة جديدة.'
                : type === 'region'
                    ? `المحافظة: ${gov}`
                    : `المحافظة: ${gov} — المنطقة: ${region}`;
            modal.show();
            setTimeout(() => valueInput.focus(), 200);
        });
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const type = typeInput.value;
        const value = valueInput.value.trim();
        const gov = governorateSelect?.value || '';
        const region = regionSelect?.value || '';
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري الحفظ...';
        try {
            await addLocationToSheet(type, value, gov, region);
            modal.hide();
            if (typeof window.showToast === 'function') {
                window.showToast('تمت إضافة البيانات بنجاح. جاري تحديث القوائم...');
            } else {
                console.log('تمت إضافة البيانات بنجاح. جاري تحديث القوائم...');
            }
            const result = await refreshAppCache({ silent: true });
            if (!result.ok) throw result.error || new Error('تمت الإضافة لكن تعذر تحديث القوائم');

            // Select the newly-added value immediately after refresh.
            if (type === 'governorate') {
                $('#governorate').val(value).trigger('change');
            } else if (type === 'region') {
                $('#region').val(value).trigger('change');
            } else if (type === 'market') {
                $('#market_name').val(value).trigger('change');
            }
        } catch (error) {
            alert(`تعذر إضافة البيانات: ${error.message || error}`);
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-save me-1"></i>حفظ';
        }
    });
}

// ===================================================================
//                      4. منطق صفحة إدخال التقارير
// ===================================================================
async function handleReportPage() {
    let isFormDirty = false;
    let stateRestoring = false;
    
    const mainContainer = document.querySelector('.main-container');
    const form = document.getElementById('reportForm');
    form.style.display = 'none';
    mainContainer.insertAdjacentHTML('afterbegin', `<div id="loading-spinner" class="text-center p-5"><div class="mx-auto mb-3" style="width:80%;"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line skeleton-line-medium"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line skeleton-line-short"></div><div class="skeleton skeleton-card"></div></div></div>`);
    let DB = await getDbData();
    if (!DB) {
        const logoutOnClick = "localStorage.clear(); sessionStorage.clear(); if (typeof navigateTo === 'function') { navigateTo('login'); } else { window.location.href = 'index.html'; } return false;";
        mainContainer.innerHTML = `<div class="alert alert-danger">فشل تحميل البيانات الأساسية. يرجى <a href="#" onclick="${logoutOnClick}">تسجيل الخروج</a> والمحاولة مرة أخرى.</div>`;
        return;
    }
    // إصلاح ذاتي: كاش قديم من نسخة ما قبل دمج الموظفين → نجلب البيانات في الخلفية
    // حتى تظهر أسماء "الأشخاص المتواجدين ضمن النقطة" دون انتظار الشاشة.
    if (!Array.isArray(DB.employees) && navigator.onLine) {
        try {
            apiGet('getInitialData', { forceRefresh: 1, v: APP_DB_VERSION }).then(fresh => {
                if (!fresh || fresh.status === 'error') return;
                memoryDbCache = fresh;
                localStorage.setItem(appDbCacheKey(), JSON.stringify(fresh));
                localStorage.setItem(appDbCacheTsKey(), String(Date.now()));
                window.dispatchEvent(new CustomEvent('dbCacheRefreshed', { detail: fresh }));
            }).catch(err => console.warn('تعذر إصلاح كاش الموظفين:', err));
        } catch (e) {}
    }
    // Update the in-memory DB immediately when the user refreshes the cache.
    // No page reload is needed, so an unfinished report is not lost.
    window.addEventListener('dbCacheRefreshed', (event) => {
        if (!event.detail) return;
        DB = event.detail;
        if (!Array.isArray(DB.competitorProducts)) DB.competitorProducts = [];
        try {
            // Rebuild the main selects from the fresh data where applicable.
            const selectedGovernorate = governorateSelect.value;
            const selectedRegion = regionSelect.value;
            const selectedMarket = marketSelect.value;
            const selectedCampaign = campaignSelect.value;

            if (typeof populateSelect === 'function') {
                const locations = Array.isArray(DB.locations) ? DB.locations : [];
                const governors = [...new Set(locations.map(l => String(l.gov ?? '').trim()).filter(Boolean))];
                const regions = selectedGovernorate
                    ? [...new Set(locations.filter(l => String(l.gov ?? '').trim() === String(selectedGovernorate).trim())
                        .map(l => String(l.region ?? '').trim()).filter(Boolean))]
                    : [];
                const markets = selectedGovernorate && selectedRegion
                    ? [...new Set(locations.filter(l =>
                        String(l.gov ?? '').trim() === String(selectedGovernorate).trim() &&
                        String(l.region ?? '').trim() === String(selectedRegion).trim())
                        .map(l => String(l.market ?? '').trim()).filter(Boolean))]
                    : [];

                populateSelect(governorateSelect, governors, selectedGovernorate);
                populateSelect(regionSelect, regions, selectedRegion);
                populateSelect(marketSelect, markets, selectedMarket);
            }

            // Re-run dependent product filtering without touching existing rows.
            if (typeof updateProductAvailability === 'function') updateProductAvailability();
        } catch (e) {
            console.warn('In-page DB refresh UI update skipped:', e);
        }
    });

    document.getElementById('loading-spinner').remove();
    form.style.display = 'block';
    setupLocationAddButtons(DB);

    const reportForm = document.getElementById('reportForm'), governorateSelect = document.getElementById('governorate'), regionSelect = document.getElementById('region'), marketSelect = document.getElementById('market_name'), campaignSelect = document.getElementById('campaign'), salesTableBody = document.getElementById('sales-table-body'), salesCard = document.getElementById('salesCard'), expensesTableBody = document.getElementById('expenses-table-body'), addSaleRowBtn = document.getElementById('add-sale-row'), addExpenseRowBtn = document.getElementById('add-expense-row'), mainSubmitBtn = document.querySelector('.main-submit-btn'), supervisorInput = document.getElementById('supervisor'), submitAndAddAnotherBtn = document.getElementById('submitAndAddAnotherBtn');
    const competitorSalesCard = document.getElementById('competitorSalesCard'), competitorSalesTableBody = document.getElementById('competitor-sales-table-body'), addCompetitorSaleRowBtn = document.getElementById('add-competitor-sale-row'), competitorProductModal = new bootstrap.Modal(document.getElementById('competitorProductSelectionModal')), competitorProductSearchInput = document.getElementById('competitorProductSearchInput'), competitorProductSelectionTbody = document.querySelector('#competitorProductSelectionTable tbody'), addSelectedCompetitorProductsBtn = document.getElementById('addSelectedCompetitorProductsBtn');
    const productModal = new bootstrap.Modal(document.getElementById('productSelectionModal'));
    const productSearchInput = document.getElementById('productSearchInput');
    const productSelectionTbody = document.querySelector('#productSelectionTable tbody');
    const addSelectedProductsBtn = document.getElementById('addSelectedProductsBtn');
    const expenseModal = new bootstrap.Modal(document.getElementById('expenseSelectionModal'));
    const expenseSearchInput = document.getElementById('expenseSearchInput');
    const expenseSelectionTbody = document.querySelector('#expenseSelectionTable tbody');
    const addSelectedExpensesBtn = document.getElementById('addSelectedExpensesBtn');
    const successModal = new bootstrap.Modal(document.getElementById('successModal'));
    const viewReportBtn = document.getElementById('viewReportBtn');

    const toastContainer = document.getElementById('toast-notification');
    const toastMessage = toastContainer.querySelector('.toast-message');
    const showToast = (message, isError = false) => {
        toastMessage.textContent = message;
        toastMessage.classList.toggle('error', isError);
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 3000);
    };
    window.showToast = showToast;

    const spawnConfetti = (count = 90) => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const colors = ['#4f46e5', '#22d3ee', '#34d399', '#f59e0b', '#e11d48', '#a78bfa', '#0ea56f'];
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
            const piece = document.createElement('span');
            piece.className = 'confetti-piece';
            piece.style.left = (Math.random() * 100).toFixed(2) + 'vw';
            piece.style.background = colors[i % colors.length];
            piece.style.setProperty('--drift', ((Math.random() * 90) - 45).toFixed(1) + 'px');
            piece.style.animationDelay = (Math.random() * .45).toFixed(2) + 's';
            piece.style.animationDuration = (2.2 + Math.random() * 1.6).toFixed(2) + 's';
            fragment.appendChild(piece);
        }
        document.body.appendChild(fragment);
        setTimeout(() => document.querySelectorAll('.confetti-piece').forEach(p => p.remove()), 5200);
    };

    // استعادة آخر نقطة — يحفظ بيانات سياق النقطة لصاحب الحساب الحالي.
    const lastPointKey = () => ownerScopedKey('lastReportPoint');
    const restoreLastPointBtn = document.getElementById('restoreLastPointBtn');
    const refreshRestoreBtn = () => {
        if (!restoreLastPointBtn) return;
        // يظهر لكل موظف؛ بيانات النقطة نفسها تبقى منفصلة لكل حساب.
        restoreLastPointBtn.classList.remove('d-none');
    };
    const saveLastPoint = (reportData) => {
        const source = reportData || {
            governorate: $('#governorate').val(),
            region: $('#region').val(),
            market: $('#market_name').val(),
            campaign: $('#campaign').val(),
            event: $('#event').val(),
            eventDays: document.getElementById('eventDays').value,
            coordinator: $('#coordinator').val(),
            inventoryDependency: $('#inventoryDependency').val(),
            supervisor: supervisorInput.value,
            phoneNumber: document.getElementById('phoneNumber')?.value || '',
            latitude: document.getElementById('latitude')?.value || '',
            longitude: document.getElementById('longitude')?.value || ''
        };
        const point = {
            governorate: source.governorate || '',
            region: source.region || '',
            market: source.market || '',
            campaign: source.campaign || '',
            event: source.event || '',
            eventDays: source.eventDays || '1',
            coordinator: source.coordinator || '',
            inventoryDependency: source.inventoryDependency || '',
            supervisor: source.supervisor || '',
            phoneNumber: source.phoneNumber || '',
            latitude: source.latitude || '',
            longitude: source.longitude || ''
        };
        if (!point.governorate || !point.market) return;
        localStorage.setItem(lastPointKey(), JSON.stringify({
            ...point,
            savedAt: Date.now()
        }));
        refreshRestoreBtn();
    };
    const applyLastPoint = () => {
        let last;
        try { last = JSON.parse(localStorage.getItem(lastPointKey()) || ''); } catch (e) { return; }
        if (!last) {
            showToast('لا توجد نقطة محفوظة لهذا الحساب بعد.', true);
            return;
        }
        const currentForm = getFormState();
        const hasUnsavedTransactions = [
            ...(currentForm.sales || []),
            ...(currentForm.salesOfCompetitor || []),
            ...(currentForm.expenses || [])
        ].some(item =>
            String(item.product || item.item || '').trim() ||
            Number(item.quantity || 0) > 0 ||
            Number(item.price || 0) > 0
        );
        if (hasUnsavedTransactions) {
            showToast('أرسل التقرير الحالي أولاً؛ استعادة النقطة لا تستبدل المبيعات أو المصاريف غير المحفوظة.', true);
            return;
        }
        stateRestoring = true;
        if (last.governorate) $('#governorate').val(last.governorate).trigger('change');
        if (last.region) $('#region').val(last.region).trigger('change');
        if (last.market) $('#market_name').val(last.market).trigger('change');
        if (last.campaign) $('#campaign').val(last.campaign).trigger('change');
        if (last.event) $('#event').val(last.event).trigger('change');
        if (last.eventDays) document.getElementById('eventDays').value = last.eventDays;
        if (last.coordinator) $('#coordinator').val(last.coordinator).trigger('change');
        if (last.inventoryDependency) $('#inventoryDependency').val(last.inventoryDependency).trigger('change');
        if (last.supervisor) supervisorInput.value = last.supervisor;
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = last.phoneNumber || '';
        applyGpsToFields(last.latitude, last.longitude);
        const dateEl = document.getElementById('date');
        if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
        updateSalesVisibility();
        stateRestoring = false;
        isFormDirty = true;
        saveFormState();
        refreshRestoreBtn();
        showToast('تمت استعادة آخر نقطة.');
    };
    restoreLastPointBtn?.addEventListener('click', applyLastPoint);

    // V62: موقع المحل (GPS) — التقاط مشترك يستخدمه الزر وعملية الإرسال.
    const captureGps = () => new Promise((resolve) => {
        if (!('geolocation' in navigator)) { resolve(null); return; }
        const timeoutId = setTimeout(() => resolve(null), 4000);
        navigator.geolocation.getCurrentPosition(
            pos => { clearTimeout(timeoutId); resolve({ latitude: Number(pos.coords.latitude.toFixed(6)), longitude: Number(pos.coords.longitude.toFixed(6)) }); },
            () => { clearTimeout(timeoutId); resolve(null); },
            { enableHighAccuracy: false, timeout: 3500, maximumAge: 60000 }
        );
    });
    const applyGpsToFields = (lat, lng) => {
        const latEl = document.getElementById('latitude');
        const lngEl = document.getElementById('longitude');
        const link = document.getElementById('openMapsLink');
        if (latEl) latEl.value = lat ? String(lat) : '';
        if (lngEl) lngEl.value = lng ? String(lng) : '';
        if (link) {
            if (lat && lng) { link.classList.remove('d-none'); link.href = 'https://www.google.com/maps?q=' + encodeURIComponent(lat + ',' + lng); }
            else link.classList.add('d-none');
        }
    };
    const getLocationBtn = document.getElementById('getMyLocationBtn');
    getLocationBtn?.addEventListener('click', async () => {
        const status = document.getElementById('gpsStatus');
        if (!('geolocation' in navigator)) { if (status) status.textContent = 'الموقع غير متاح على هذا الجهاز.'; return; }
        if (status) status.textContent = 'جارٍ تحديد الموقع...';
        getLocationBtn.disabled = true;
        const pos = await captureGps();
        getLocationBtn.disabled = false;
        if (pos) {
            applyGpsToFields(pos.latitude, pos.longitude);
            if (status) status.textContent = 'تم تحديد الموقع.';
            isFormDirty = true;
            saveFormState();
        } else {
            applyGpsToFields(null, null);
            if (status) status.textContent = 'تعذر تحديد الموقع — اسمح بالوصول إلى الموقع وحاول مجدداً.';
        }
    });

    const getFormState = () => {
        const loggedUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser')) || {};
        const directPromotion = String($('#event').val() || '').trim() === 'ترويج مباشر';
        return {
        governorate: $('#governorate').val(), region: $('#region').val(), market: $('#market_name').val(),
        campaign: $('#campaign').val(), event: $('#event').val(),
        eventDays: document.getElementById('eventDays').value, date: document.getElementById('date').value,
        phoneNumber: document.getElementById('phoneNumber')?.value.trim() || '',
        timeFrom: document.getElementById('timeFrom').value, timeTo: document.getElementById('timeTo').value,
        inventoryDependency: $('#inventoryDependency').val(), coordinator: $('#coordinator').val(),
        promoter1: $('#promoter1').val(), promoter2: $('#promoter2').val(),
        promoter3: $('#promoter3').val(), promoter4: $('#promoter4').val(),
        latitude: document.getElementById('latitude')?.value?.trim() || '',
        longitude: document.getElementById('longitude')?.value?.trim() || '',
        promoters: getSelectedPromoters(),
        notes: document.getElementById('notes').value,
        sales: directPromotion ? [] : Array.from(salesTableBody.querySelectorAll('tr')).map(r => ({ product: $(r.querySelector('.sale-product')).val(), price: Number(r.querySelector('.sale-price').value) || 0, quantity: Number(r.querySelector('.sale-quantity').value) || 0, campaign: $('#campaign').val() })),
        salesOfCompetitor: Array.from(document.querySelectorAll('#competitor-sales-table-body tr')).map(r => ({ product: $(r.querySelector('.competitor-product')).val(), price: Number(r.querySelector('.competitor-price').value) || 0, quantity: Number(r.querySelector('.competitor-quantity').value) || 0 })),
        expenses: Array.from(expensesTableBody.querySelectorAll('tr')).map(r => ({ item: $(r.querySelector('.expense-item')).val(), quantity: r.querySelector('.expense-quantity').value })),
        createdById: loggedUser.id || '',
        createdByName: loggedUser.name || '',
        };
    };
    const saveFormState = () => {
        if (isFormDirty) {
            localStorage.setItem(formStateKey(), JSON.stringify(getFormState()));
            const draft = document.getElementById('draftStatus');
            if (draft) {
                draft.textContent = '✓ تُحفظ المسودة تلقائياً';
                draft.classList.add('show');
                clearTimeout(draft._hideTimer);
                draft._hideTimer = setTimeout(() => draft.classList.remove('show'), 1600);
            }
        }
    };
    const loadFormState = () => {
        const savedState = localStorage.getItem(formStateKey());
        if (!savedState) return;
        stateRestoring = true;
        const state = JSON.parse(savedState);
        $('#campaign').val(state.campaign).trigger('change');
        $('#event').val(state.event).trigger('change');
        document.getElementById('eventDays').value = state.eventDays;
        document.getElementById('date').value = state.date;
        document.getElementById('timeFrom').value = state.timeFrom;
        document.getElementById('timeTo').value = state.timeTo;
        document.getElementById('notes').value = state.notes;
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = state.phoneNumber || '';
        applyGpsToFields(state.latitude, state.longitude);
        $('#inventoryDependency').val(state.inventoryDependency).trigger('change');
        $('#coordinator').val(state.coordinator).trigger('change');
        $('#promoter1').val(state.promoter1).trigger('change');
        $('#promoter2').val(state.promoter2).trigger('change');
        $('#promoter3').val(state.promoter3).trigger('change');
        setSelectedPromoters([state.promoter1, state.promoter2, state.promoter3, state.promoter4]);
        if (state.governorate) {
            $('#governorate').val(state.governorate).trigger('change');
            if (state.region) {
                $('#region').val(state.region).trigger('change');
                if (state.market) {
                    $('#market_name').val(state.market).trigger('change');
                }
            }
        }
        salesTableBody.innerHTML = '';
        if (state.sales) state.sales.forEach(createSaleRow);
        if (state.salesOfCompetitor && typeof createCompetitorSaleRow === 'function') state.salesOfCompetitor.forEach(createCompetitorSaleRow);
        expensesTableBody.innerHTML = '';
        if (state.expenses) state.expenses.forEach(createExpenseRow);
        updateSaleTotals();
        stateRestoring = false;
        isFormDirty = true;
    };

    reportForm.addEventListener('input', () => { isFormDirty = true; saveFormState(); });
    reportForm.addEventListener('change', refreshRestoreBtn);
    refreshRestoreBtn();
    window.addEventListener('beforeunload', (event) => { if (isFormDirty) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('pagehide', () => { if (isFormDirty) saveFormState(); });

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));

    const initSelect2 = (selector, placeholder, allowTags = false) => { 
        $(selector).select2({ 
            theme: 'bootstrap-5', 
            dir: 'rtl', 
            placeholder, 
            width: '100%',
            tags: allowTags 
        }).on('change', () => { 
            isFormDirty = true; 
            saveFormState(); 
        }); 
    };
    const populateSelect = (select, options, selectedVal = '') => {
        const currentVal = $(select).val();
        const placeholder = select.querySelector('option[disabled]').textContent;
        // اجمع الخيارات في مصفوفة ثم اكتبها دفعة واحدة. `innerHTML +=` داخل
        // حلقة يُعيد تحليل HTML المجمَّع مع كل خيار، فالتكلفة O(n^2): 200 خيار
        // تعيد تحليل ~1.1 ميغابايت. الإسناد الواحد تحليل واحد.
        const parts = [`<option value="" selected disabled>${placeholder}</option>`];
        if (select.id.startsWith('promoter') || select.id === 'inventoryDependency' || select.id === 'coordinator') {
            parts.push(`<option value="">غير محدد</option>`);
        }
        for (const opt of options) {
            parts.push(`<option value="${opt}" ${opt === selectedVal ? 'selected' : ''}>${opt}</option>`);
        }
        select.innerHTML = parts.join('');
        $(select).val(selectedVal || currentVal).trigger('change.select2');
    };
    const isValidPromoterName = (value) => {
        if (value === null || value === undefined) return false;
        const name = String(value).trim();
        return !!name && name.toLowerCase() !== 'undefined' && name.toLowerCase() !== 'null' && name !== '-';
    };

    const PROMOTERS_REQUIRED_MESSAGE = 'يجب اختيار شخص واحد على الأقل ضمن الأشخاص المتواجدين بالنقطة';

    /**
     * «الأشخاص المتواجدين ضمن النقطة» is required.
     *
     * The value lives in four hidden inputs, and an input[type=hidden] is barred
     * from constraint validation: `required` and setCustomValidity on it are
     * both ignored, so checkValidity() would pass with nobody selected. The rule
     * is therefore enforced explicitly at the submit gate and mirrored on the
     * button, which is the control the user can actually see and act on.
     */
    const validatePromotersPresence = () => {
        const present = getSelectedPromoters().length > 0;
        const btn = document.getElementById('openPromotersBtn');
        const hint = document.getElementById('promotersRequiredHint');
        const label = document.getElementById('promotersLabel');
        if (btn) btn.classList.toggle('is-invalid', !present);
        if (hint) hint.classList.toggle('d-none', present);
        if (label) label.classList.toggle('text-danger', !present);
        return present;
    };

    /**
     * The coordinator is by definition present at their own point, so they are
     * added to the list by default.
     *
     * This is a default, not a lock: the row stays tickable-off in the picker,
     * which is what keeps the required rule meaningful. It only ever adds, so
     * it can never silently drop a name the user chose.
     */
    const includeCoordinatorAsPromoter = () => {
        const coordinatorName = String(document.getElementById('coordinator')?.value || '').trim();
        if (!isValidPromoterName(coordinatorName)) return;
        // Prepended, because setSelectedPromoters keeps only four names: the
        // coordinator has to displace the last entry, not be the one dropped.
        setSelectedPromoters([coordinatorName, ...getSelectedPromoters()]);
    };

    const normalizePromoterNames = (names = []) => [...new Set(
        (Array.isArray(names) ? names : [names])
            .map(v => String(v ?? '').trim())
            .filter(isValidPromoterName)
    )];

    const getSelectedPromoters = () => normalizePromoterNames(
        [1,2,3,4].map(num => document.getElementById(`promoter${num}`)?.value)
    );

    const setSelectedPromoters = (names = []) => {
        const unique = normalizePromoterNames(names);
        [1,2,3,4].forEach((num, index) => {
            const input = document.getElementById(`promoter${num}`);
            if (input) input.value = unique[index] || '';
        });
        const text = document.getElementById('selectedPromotersText');
        const badges = document.getElementById('selectedPromotersBadges');
        if (text) text.textContent = unique.length ? `تم اختيار ${unique.length} من الأشخاص` : 'اختر الأشخاص المتواجدين ضمن النقطة...';
        if (badges) badges.innerHTML = unique.map(name => `<span class="badge text-bg-primary">${escapeHtml(name)}</span>`).join('');
    };

    const populateEmployees = (report = {}) => {
        const inventoryStaff = DB.employees.filter(e => e.role === 'مسؤول جرد').map(e => e.name);
        const coordinators = DB.employees.filter(e => e.role === 'منسق نقطة' || e.role === 'مسؤول جرد').map(e => e.name);
        populateSelect(document.getElementById('inventoryDependency'), inventoryStaff, report.inventoryDependency);
        populateSelect(document.getElementById('coordinator'), coordinators, report.coordinator);
        const reportPromoters = Array.isArray(report.promoters)
            ? report.promoters
            : [report.promoter1, report.promoter2, report.promoter3, report.promoter4];
        setSelectedPromoters(normalizePromoterNames(reportPromoters));
        // After the saved list, not before: populateSelect fires change on the
        // coordinator, but this must win over the report's own promoters so a
        // report saved before the coordinator was in the list still ends up
        // with them present.
        includeCoordinatorAsPromoter();
    };

    const promotersSelectionModal = new bootstrap.Modal(document.getElementById('promotersSelectionModal'));
    const promotersSearchInput = document.getElementById('promotersSearchInput');
    const promotersSelectionTbody = document.querySelector('#promotersSelectionTable tbody');
    const promotersEmptyMessage = document.getElementById('promotersEmptyMessage');
    const openPromotersBtn = document.getElementById('openPromotersBtn');
    const savePromotersBtn = document.getElementById('savePromotersBtn');

    const isPromoterRoleValue = (value) => {
        const s = String(value ?? '').trim();
        return s === 'مروج' || s === 'مروّج' || /^(promoter|promoters)$/i.test(s);
    };
    const isCoordinatorRoleValue = (value) => {
        const s = String(value ?? '').trim();
        return s === 'منسق نقطة' || /^(coordinator|coordinators)$/i.test(s);
    };
    const renderPromotersSelection = () => {
        const employees = Array.isArray(DB && DB.employees) ? DB.employees : [];
        const supervisorName = (supervisorInput?.value || '').trim();
        let promoters = employees
            .filter(e => e && (isPromoterRoleValue(e.role ?? e.jobPosition ?? '') || isCoordinatorRoleValue(e.role ?? e.jobPosition ?? '')))
            .map(e => String(e.name ?? '').trim())
            .filter(isValidPromoterName)
            .filter((name, index, arr) => arr.indexOf(name) === index);
        // كل الموظفين التابعين للمشرف المعروض في خانة "المشرف" يُضافون للقائمة.
        if (supervisorName) {
            const teamNames = employees
                .filter(e => e && String(e.mgr ?? '').trim() === supervisorName)
                .map(e => String(e.name ?? '').trim())
                .filter(isValidPromoterName);
            promoters = [...promoters, ...teamNames].filter((name, index, arr) => arr.indexOf(name) === index);
        }
        const selected = new Set(getSelectedPromoters());
        promotersSelectionTbody.innerHTML = '';
        const query = (promotersSearchInput?.value || '').toLowerCase().trim();
        const visible = promoters.filter(name => name.toLowerCase().includes(query));
        if (!visible.length) {
            promotersEmptyMessage.classList.remove('d-none');
            return;
        }
        promotersEmptyMessage.classList.add('d-none');
        visible.forEach(name => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td><div class="form-check"><input class="form-check-input promoter-checkbox" type="checkbox" value="${escapeHtml(name)}" ${selected.has(name) ? 'checked' : ''}></div></td><td>${escapeHtml(name)}</td>`;
            tr.addEventListener('click', e => {
                if (e.target.tagName !== 'INPUT') {
                    const cb = tr.querySelector('.promoter-checkbox');
                    cb.checked = !cb.checked;
                }
            });
            promotersSelectionTbody.appendChild(tr);
        });
    };

    openPromotersBtn?.addEventListener('click', () => {
        renderPromotersSelection();
        promotersSelectionModal.show();
    });
    promotersSearchInput?.addEventListener('input', renderPromotersSelection);
    // The coordinator belongs among the people present, so choosing one fills
    // the list without the user having to open the picker.
    document.getElementById('coordinator')?.addEventListener('change', () => {
        includeCoordinatorAsPromoter();
        isFormDirty = true;
        saveFormState();
    });
    savePromotersBtn?.addEventListener('click', () => {
        const selected = Array.from(promotersSelectionTbody.querySelectorAll('.promoter-checkbox:checked')).map(cb => cb.value);
        // إذا كانت القائمة مفلترة، نحافظ على الاختيارات الموجودة خارج نتيجة البحث.
        const current = new Set(getSelectedPromoters());
        const visibleNames = Array.from(promotersSelectionTbody.querySelectorAll('.promoter-checkbox')).map(cb => cb.value);
        visibleNames.forEach(name => current.delete(name));
        selected.forEach(name => current.add(name));
        setSelectedPromoters(Array.from(current));
        validatePromotersPresence();
        isFormDirty = true;
        saveFormState();
        promotersSelectionModal.hide();
    });

    const updateSaleTotals = () => {
        let grandTotal = 0, totalQuantity = 0;
        salesTableBody.querySelectorAll('tr').forEach(row => {
            const price = parseFloat(row.querySelector('.sale-price').value) || 0;
            const quantity = parseInt(row.querySelector('.sale-quantity').value) || 0;
            const rowTotal = price * quantity;
            row.querySelector('.row-total').value = rowTotal.toFixed(2);
            grandTotal += rowTotal;
            totalQuantity += quantity;
        });
        document.getElementById('grandTotal').textContent = grandTotal.toFixed(2);
        document.getElementById('totalQuantity').textContent = totalQuantity;
    };
    // ===============================================================
    //                         SALES / BARCODE
    // ===============================================================
    const isCancelledProduct = (product) => {
        if (!product) return true;
        if (product.cancelled === true) return true;
        const value = String(product.cancelled ?? '').trim().toLowerCase();
        return value === 'true' || value === '1' || value === 'yes' || value === 'نعم';
    };

    // «شاملة» و«مهرجان» حملتان تجميعيتان: تغطّيان كل مواد كل الحملات، وليس لهما
    // صفوف خاصة بهما في ورقة Products. أي اختلاف في المعالجة بينهما كان يُظهر
    // قائمة مواد فارغة أو يرفض حفظ السعر.
    const AGGREGATE_CAMPAIGNS = ['شاملة', 'مهرجان'];
    const isAggregateCampaign = (name) => AGGREGATE_CAMPAIGNS.includes(String(name ?? '').trim());

    const normalizeCategory = (value) => String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');

    // تصنيف مرن: ورقة Products قد تفتقد عمود «تصنيف المادة» أو تستعمل صيغة أخرى،
    // والمطابقة بالنص الحرفي كانت تُفرغ القائمة بالكامل. نُطبّع ما نستطيعه.
    const CATEGORY_SALE = 'مادة بيعية';
    const CATEGORY_TASTING = 'مادة تذوق';
    const classifyCategory = (value) => {
        const raw = normalizeCategory(value);
        if (!raw) return '';
        const t = raw.toLowerCase();
        if (/(بيع|بيعه|sale|sell)/.test(t)) return CATEGORY_SALE;
        if (/(تذوق|tast|sampl)/.test(t)) return CATEGORY_TASTING;
        return raw;
    };
    const isSaleCategory = (value) => classifyCategory(value) === CATEGORY_SALE;
    const isTastingCategory = (value) => classifyCategory(value) === CATEGORY_TASTING;

    // اتحاد كل الحملات مع دمج صفّ واحد لكل اسم مادة.
    // كان آخر صف يفوز فقط، فمادة «مادة تذوق» في حملة لاحقة كانت تُخفي نسخة
    // «مادة بيعية» لنفس الاسم من قائمة البيع داخل الحملات التجميعية.
    const getAllProductsMerged = () => {
        const merged = new Map();
        Object.values(DB.products || {}).flat().forEach(p => {
            if (!p || !p.name || isCancelledProduct(p)) return;
            const name = String(p.name).trim();
            const category = classifyCategory(p.category);
            const found = merged.get(name);
            if (!found) {
                merged.set(name, { ...p, name, category });
                return;
            }
            // ادمج سمات الاسم: إن كان بيعاً أو تذوقاً في أي حملة يبقى كذلك هنا.
            const mergedCats = new Set([found.category, category].filter(Boolean));
            found.category = Array.from(mergedCats).join('، ');
            if (!normalizeBarcode(found.barcode) && normalizeBarcode(p.barcode)) found.barcode = p.barcode;
            if (!Number(found.price) && Number(p.price)) found.price = Number(p.price);
            if (!normalizeCategory(found.company) && normalizeCategory(p.company)) found.company = p.company;
        });
        return Array.from(merged.values());
    };

    const getCampaignProducts = () => {
        const campaignName = campaignSelect.value;
        const products = isAggregateCampaign(campaignName)
            ? getAllProductsMerged()
            : (DB.products?.[campaignName] || []);
        return products.filter(p => p && p.name && !isCancelledProduct(p));
    };

    // للحملات التجميعية تُعرض كل المواد (بيعاً كان أم تذوقاً) لأن الحملة تغطّي الكل.
    // للحملات العادية نفلتر بالتصنيف، وإن خرجت القائمة فارغة نُظهر كل مواد الحملة
    // بدل ترك المستخدم أمام قائمة فارغة.
    const pickByCategory = (predicate) => {
        const products = getCampaignProducts();
        if (isAggregateCampaign(campaignSelect.value)) return products;
        const matched = products.filter(p => predicate(p.category));
        return matched.length ? matched : products;
    };

    const getSaleProducts = () => pickByCategory(isSaleCategory);
    const isDirectSaleEvent = () => String($('#event').val() || '').trim() === 'ترويج وبيع مباشر';
    const getSaleDisplayPrice = (product) => isDirectSaleEvent() ? Number(product?.price || 0) : '';
    const getCompetitorProducts = () => Array.isArray(DB.competitorProducts)
        ? DB.competitorProducts.filter(p => p && p.name && !isCancelledProduct(p))
        : [];
    const getTastingProducts = () => pickByCategory(isTastingCategory);

    const normalizeBarcode = (value) => String(value ?? '').trim();

    const findProductByBarcode = (barcode) => {
        const code = normalizeBarcode(barcode);
        if (!code) return null;

        const products = getSaleProducts().filter(
            p => normalizeBarcode(p.barcode) === code
        );
        if (!products.length) return null;

        // إذا كان الباركود موجوداً بأكثر من سجل، استخدم السعر المعتمد
        // في بيانات Products. وبعد تعديل السعر يتم تحديث جميع سجلات
        // المادة/الباركود في الشيت ثم إعادة بناء الكاش.
        const product = products[products.length - 1];
        return {...product, price: getSaleDisplayPrice(product)};
    };

    const findSaleRowByProduct = (productName, approvedPrice) => {
        const rows = Array.from(salesTableBody.querySelectorAll('tr')).filter(row =>
            $(row.querySelector('.sale-product')).val() === productName
        );
        if (!rows.length) return null;

        // عند وجود المادة مرتين في المبيعات بسعرين مختلفين:
        // الباركود يجب أن يزيد كمية السطر الذي يحمل السعر المعتمد،
        // وليس أول سطر عشوائياً.
        const masterPrice = Number(approvedPrice);
        if (Number.isFinite(masterPrice)) {
            const matching = rows.find(row => {
                const rowPrice = Number(row.querySelector('.sale-price')?.value);
                return Number.isFinite(rowPrice) && Math.abs(rowPrice - masterPrice) < 0.000001;
            });
            if (matching) return matching;
        }
        return rows[0];
    };

    const focusBarcodeInput = () => {
        const input = document.getElementById('barcodeInput');
        if (input) setTimeout(() => input.focus(), 50);
    };

    let scanAudioCtx = null;
    const playScanBeep = (success = true) => {
        try {
            scanAudioCtx = scanAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (scanAudioCtx.state === 'suspended') scanAudioCtx.resume();
            const now = scanAudioCtx.currentTime;
            const osc = scanAudioCtx.createOscillator();
            const gain = scanAudioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(success ? 880 : 220, now);
            if (success) osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
            osc.connect(gain).connect(scanAudioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.2);
        } catch (e) {}
    };

    const flashSaleRow = (row) => {
        if (!row) return;
        row.classList.remove('row-flash');
        void row.offsetWidth;
        row.classList.add('row-flash');
    };

    const addProductToSalesByBarcode = (rawBarcode) => {
        const barcode = normalizeBarcode(rawBarcode);
        const status = document.getElementById('barcodeStatus');
        if (!barcode) return false;

        // بعض أجهزة USB ترسل نفس المسح مرتين: input ثم Enter.
        // امنع التكرار الآلي فقط، مع السماح بمسح نفس المادة مرة أخرى بعد مهلة قصيرة.
        const now = Date.now();
        if (barcode === lastSalesBarcode && (now - lastSalesBarcodeAt) < 800) {
            const input = document.getElementById('barcodeInput');
            if (input) input.value = '';
            return false;
        }
        lastSalesBarcode = barcode;
        lastSalesBarcodeAt = now;

        if (!campaignSelect.value) {
            status.textContent = 'يرجى اختيار نوع الحملة أولاً.';
            status.className = 'small mt-2 text-danger';
            showToast('يرجى اختيار نوع الحملة أولاً.', true);
            playScanBeep(false);
            focusBarcodeInput();
            return false;
        }

        const product = findProductByBarcode(barcode);
        if (!product) {
            status.textContent = `الباركود ${barcode} غير موجود ضمن منتجات الحملة الحالية.`;
            status.className = 'small mt-2 text-danger';
            showToast(`الباركود ${barcode} غير موجود.`, true);
            playScanBeep(false);
            focusBarcodeInput();
            return false;
        }

        const existingRow = findSaleRowByProduct(product.name, product.price);
        if (existingRow) {
            const quantityInput = existingRow.querySelector('.sale-quantity');
            const currentQty = parseInt(quantityInput.value, 10) || 0;
            quantityInput.value = currentQty + 1;
            updateSaleTotals();
            status.textContent = `تمت زيادة كمية «${product.name}» إلى ${quantityInput.value}.`;
            status.className = 'small mt-2 text-success';
            flashSaleRow(existingRow);
            showToast(`تم مسح «${product.name}» مجدداً — الكمية أصبحت ${quantityInput.value}.`);
        } else {
            createSaleRow({
                product: product.name,
                price: product.price,
                quantity: 1,
                barcode: barcode
            });
            status.textContent = `تمت إضافة «${product.name}» بسعر ${Number(product.price || 0).toFixed(2)} × 1.`;
            status.className = 'small mt-2 text-success';
            flashSaleRow(salesTableBody.querySelector('tr:last-child'));
        }

        playScanBeep(true);
        isFormDirty = true;
        saveFormState();
        const input = document.getElementById('barcodeInput');
        if (input) input.value = '';
        focusBarcodeInput();
        return true;
    };

    let priceUpdateTimer = null;
    const updateMasterProductPrice = async (row) => {
        if (!navigator.onLine) return;
        if (!isDirectSaleEvent()) return;

        const productSelect = row.querySelector('.sale-product');
        const product = String($(productSelect).val() || '').trim();
        const price = Number(row.querySelector('.sale-price')?.value);
        const campaign = String(campaignSelect.value || '').trim();
        const barcode = normalizeBarcode($(productSelect).find('option:selected').data('barcode') || '');

        if (!product || !campaign || !Number.isFinite(price) || price < 0) return;

        try {
            const result = await apiPost('updateProductPrice', { product, price, campaign, barcode });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر تحديث السعر');

            // السعر أصبح محفوظاً في Products. أعد تحميل بيانات الموقع كاملة من الـSheet
            // حتى يصبح السعر الجديد هو السعر المعتمد فوراً في الواجهة والباركود.
            await refreshAppCache({ silent: true, refreshReports: false });

            // حدّث الصف الحالي أيضاً من البيانات الجديدة، بدون إعادة فرض السعر القديم.
            row.querySelector('.sale-price').value = Number(result.price).toFixed(2);
            updateSaleTotals();
        } catch (error) {
            console.error('Immediate price update failed:', error);
            showToast(`تعذر تحديث سعر «${product}» على الشيت: ${error.message || error}`, true);
        }
    };

    const scheduleMasterProductPriceUpdate = (row) => {
        clearTimeout(priceUpdateTimer);
        priceUpdateTimer = setTimeout(() => updateMasterProductPrice(row), 120);
    };

    const createSaleRow = (sale = {}) => {
        let products = getSaleProducts();
        // لا نُسقط صامتاً صفاً محفوظاً لم تعد مادته ضمن القائمة (تغيّر التصنيف مثلاً):
        // نضيفها مؤقتاً حتى لا يفقد المستخدم بيانات تقرير قائم.
        if (sale.product && !products.some(p => p.name === sale.product)) {
            products = products.concat([{ name: sale.product, price: 0, barcode: '', category: '' }]);
        }
        const existingProducts = Array.from(salesTableBody.querySelectorAll('.sale-product')).map(select => $(select).val());
        if (sale.product && existingProducts.includes(sale.product) && !sale.price) return;

        const row = document.createElement('tr');
        const productOptions = products.map(p => {
            const safeName = String(p.name ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return `<option value="${safeName}" data-price="${getSaleDisplayPrice(p)}" data-barcode="${normalizeBarcode(p.barcode)}">${safeName}</option>`;
        }).join('');
        const priceValue = isDirectSaleEvent() ? (sale.price !== undefined && sale.price !== '' ? Number(sale.price || 0).toFixed(2) : '0.00') : (sale.price !== undefined && sale.price !== '' ? Number(sale.price).toFixed(2) : '');
        const quantityValue = sale.quantity !== undefined && sale.quantity !== '' ? sale.quantity : '';

        row.innerHTML = `<td><select class="form-select form-select-sm sale-product" required><option value="" selected disabled>اختر...</option>${productOptions}</select></td><td><input type="number" class="form-control form-control-sm sale-price" value="${priceValue}" step="0.01" required></td><td><input type="number" class="form-control form-control-sm sale-quantity" value="${quantityValue}" min="1" required></td><td><input type="text" class="form-control form-control-sm row-total" value="0.00" readonly></td><td><button type="button" class="btn btn-sm btn-outline-danger remove-row-btn"><i class="fa-solid fa-trash-can"></i></button></td>`;
        row.querySelector('.remove-row-btn').addEventListener('click', () => {
            row.remove();
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
            focusBarcodeInput();
        });

        const productSelect = $(row.querySelector('.sale-product'));
        initSelect2(productSelect, 'اختر المادة...');
        productSelect.on('change', function() {
            const newPrice = $(this).find('option:selected').data('price');
            if (newPrice !== undefined && newPrice !== '') {
                row.querySelector('.sale-price').value = parseFloat(newPrice).toFixed(2);
            }
            if (!stateRestoring) {
                const chosen = String($(this).val() || '');
                const alreadyPresent = chosen && Array.from(salesTableBody.querySelectorAll('tr'))
                    .some(r => r !== row && $(r.querySelector('.sale-product')).val() === chosen);
                if (alreadyPresent) {
                    flashSaleRow(row);
                    showToast('انتبه: هذه المادة مذكورة في أكثر من صف ضمن الجدول.', false);
                }
            }
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
        });

        row.querySelector('.sale-quantity').addEventListener('input', () => {
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
        });
        row.querySelector('.sale-price').addEventListener('input', () => {
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
            // تحديث السعر المعتمد تلقائياً بعد توقف المستخدم عن الكتابة.
            scheduleMasterProductPriceUpdate(row);
        });
        row.querySelector('.sale-price').addEventListener('change', () => {
            updateSaleTotals();
            isFormDirty = true;
            saveFormState();
            scheduleMasterProductPriceUpdate(row);
        });

        salesTableBody.appendChild(row);
        if (sale.product) productSelect.val(sale.product).trigger('change');
        if (sale.price !== undefined && sale.price !== '') row.querySelector('.sale-price').value = Number(sale.price || 0).toFixed(2);
        if (sale.quantity !== undefined && sale.quantity !== '') row.querySelector('.sale-quantity').value = sale.quantity;
        updateSaleTotals();
        return row;
    };

    const createExpenseRow = (expense = {}) => {
        let expenseProducts = getTastingProducts();
        // نفس المبدأ: مادة محفوظة لم تعد ضمن القائمة تبقى محفوظة بدل أن تضيع.
        if (expense.item && !expenseProducts.some(p => p.name === expense.item)) {
            expenseProducts = expenseProducts.concat([{ name: expense.item, barcode: '', category: '' }]);
        }
        const existingExpenses = Array.from(expensesTableBody.querySelectorAll('.expense-item')).map(select => $(select).val());
        if (expense.item && existingExpenses.includes(expense.item) && !expense.quantity) return;

        const row = document.createElement('tr');
        const expenseOptions = expenseProducts.map(product => {
            const safeName = String(product.name ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return `<option value="${safeName}" data-barcode="${normalizeBarcode(product.barcode)}">${safeName}</option>`;
        }).join('');

        row.innerHTML = `<td><select class="form-select form-select-sm expense-item" required><option value="" selected disabled>اختر...</option>${expenseOptions}</select></td><td><input type="number" class="form-control form-control-sm expense-quantity" value="${expense.quantity || ''}" min="1" required></td><td><button type="button" class="btn btn-sm btn-outline-danger remove-row-btn"><i class="fa-solid fa-trash-can"></i></button></td>`;
        row.querySelector('.remove-row-btn').addEventListener('click', () => { row.remove(); isFormDirty = true; saveFormState(); });
        const expenseSelect = $(row.querySelector('.expense-item'));
        initSelect2(expenseSelect, 'اختر مادة التذوق...');
        expensesTableBody.appendChild(row);
        if (expense.item) expenseSelect.val(expense.item).trigger('change');
        if (expense.quantity) row.querySelector('.expense-quantity').value = expense.quantity;
        row.querySelector('.expense-quantity').addEventListener('input', () => { isFormDirty = true; saveFormState(); });
    };

    /**
     * [إضافة جديدة] دالة لإعادة تعيين النموذج بالكامل بدون إعادة تحميل الصفحة
     */
    const resetFullForm = () => {
        // إعادة تعيين الحقول الأساسية
        document.getElementById('eventDays').value = '1';
        document.getElementById('date').value = '';
        document.getElementById('timeFrom').value = '';
        document.getElementById('timeTo').value = '';
        document.getElementById('notes').value = '';
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = '';

        // إعادة تعيين حقول Select2
        $('#governorate, #campaign, #event, #inventoryDependency, #coordinator, #promoter1, #promoter2, #promoter3, #promoter4').val(null).trigger('change');
        // تفريغ الأشخاص المتواجدين ضمن النقطة بالكامل
        setSelectedPromoters([]);
        if (promotersSelectionTbody) {
            promotersSelectionTbody.querySelectorAll('.promoter-checkbox').forEach(cb => {
                cb.checked = false;
            });
        }
        // تفريغ القوائم المعتمدة
        $('#region, #market_name').empty().append('<option value="" selected disabled>اختر...</option>').val(null).trigger('change');

        // تفريغ الجداول
        salesTableBody.innerHTML = '';
        expensesTableBody.innerHTML = '';
        updateSaleTotals();
        refreshRestoreBtn();

        // إزالة علامات التحقق من الصحة
        reportForm.classList.remove('was-validated');

        // تفريغ حقل موقع المحل (GPS)
        applyGpsToFields(null, null);
        const gpsStatus = document.getElementById('gpsStatus');
        if (gpsStatus) gpsStatus.textContent = '';
    };

    const validateRequiredPrices = () => {
        const eventValue = String($('#event').val() || '').trim();
        const requiresUserPrice = eventValue !== 'ترويج وبيع مباشر';
        let firstInvalid = null;

        document.querySelectorAll('.sale-price, .competitor-price').forEach(input => {
            input.setCustomValidity('');
            if (requiresUserPrice && String(input.value ?? '').trim() === '') {
                input.setCustomValidity('السعر مطلوب لهذا النوع من الحدث.');
                if (!firstInvalid) firstInvalid = input;
            }
        });

        return firstInvalid;
    };

    // V61: تتبّع الموقع (GPS) — اختياري وسريع، لا يعطّل إرسال التقرير عند طلب الإذن أو فشل الإشارة.
    // يفضّل الإحداثيات الظاهرة في الحقول؛ إن كانت فارغة يحاول التقاطاً سريعاً ويعبّئها.
    const tryCaptureGps = async (reportData) => {
        const lat = document.getElementById('latitude')?.value?.trim();
        const lng = document.getElementById('longitude')?.value?.trim();
        if (lat && lng && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
            reportData.latitude = Number(lat);
            reportData.longitude = Number(lng);
            return;
        }
        if (!('geolocation' in navigator)) return;
        const pos = await captureGps();
        if (pos) {
            applyGpsToFields(pos.latitude, pos.longitude);
            reportData.latitude = pos.latitude;
            reportData.longitude = pos.longitude;
        }
    };

    // V61: كشف تكرار محتمل قبل الإرسال — نفس المحل + نفس التاريخ (+ نفس الحملة والموظف)
    // من الكاش الفوري أولاً، ثم من الخادم إن لزم — يعمل أوفلاين عبر الكاش المحفوظ.
    const findDuplicateReports = async (candidate) => {
        const market = String(candidate.market || '').trim();
        const date = String(candidate.date || '').slice(0, 10);
        if (!market || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const owner = String(candidate.createdById || '');
        let reports = Array.isArray(memoryReportsCache) ? memoryReportsCache : null;
        if (!reports && !Array.isArray(reports) && navigator.onLine && typeof cachedReportsFetch === 'function') {
            try {
                reports = await cachedReportsFetch({
                    userId: candidate.createdById || '',
                    role: String(candidate.role || localStorage.getItem('currentUser') && (JSON.parse(localStorage.getItem('currentUser')).role || '')),
                    userName: candidate.createdByName || ''
                }, { ttlMinutes: 1 });
            } catch (e) { reports = null; }
        }
        if (!Array.isArray(reports)) {
            try {
                const raw = localStorage.getItem('reportsCache');
                if (raw && raw !== 'undefined') reports = JSON.parse(raw);
            } catch (e) { reports = null; }
        }
        if (!Array.isArray(reports) || !reports.length) return null;
        const matches = reports.filter(r => {
            if (String(r.market || '').trim() !== market) return false;
            if (String(r.date || '').slice(0, 10) !== date) return false;
            if (candidate.campaign && String(r.campaign || '').trim() && String(r.campaign).trim() !== String(candidate.campaign).trim()) return false;
            if (owner && r.createdById && String(r.createdById) !== owner) return false;
            return true;
        });
        if (!matches.length) return null;
        const shown = matches.slice(0, 3).map(m =>
            `• ${m.createdByName || 'موظف'} — ${m.createdAt || 'تاريخ غير معروف'}`).join('\n');
        const extra = matches.length > 3 ? `\n... و${matches.length - 3} تقارير أخرى` : '';
        return `تم العثور على ${matches.length} تقرير مكرر محتمل بنفس المحل (${market}) والتاريخ (${date}):\n${shown}${extra}\n\nهل تريد الحفظ على أي حال؟`;
    };

    const handleFormSubmit = async (event, editId, addAnother = false) => {
        if(event) event.preventDefault();
        const firstInvalidPrice = validateRequiredPrices();
        if (firstInvalidPrice) firstInvalidPrice.focus();
        if (!reportForm.checkValidity()) {
            if(event) event.stopPropagation();
            reportForm.classList.add('was-validated');
            return;
        }
        // «الأ‍♂️ المتواجدين ضمن النقطة» مطلوب. The four inputs holding the value
        // are type=hidden, which the HTML spec bars from constraint validation,
        // so checkValidity() above cannot catch this one.
        if (!validatePromotersPresence()) {
            if(event) event.stopPropagation();
            reportForm.classList.add('was-validated');
            document.getElementById('openPromotersBtn')?.focus();
            return;
        }

        const submittedDraft = getFormState();
        const submittedDraftSnapshot = JSON.stringify(submittedDraft);
        const reportData = { ...submittedDraft };
        isFormDirty = false;
        
        reportData.id = editId || Date.now();
        reportData.createdAt = editId ? originalCreatedAt : new Date().toLocaleString('ar-EG');
        reportData.promoters = [reportData.promoter1, reportData.promoter2, reportData.promoter3, reportData.promoter4].filter(p => p && p !== 'غير محدد');
        reportData.supervisor = supervisorInput.value;
        reportData.participants = [...new Set([reportData.coordinator, reportData.inventoryDependency, reportData.supervisor, ...reportData.promoters].filter(Boolean))];

        // V61: أثر التعديل — يُرسل مع التقرير ويخزّنه الخادم في عمودي editedAt/editedBy.
        if (editId) {
            reportData.editedAt = new Date().toISOString();
            reportData.editedBy = reportData.createdByName || reportData.createdById || '';
        }

        // V61: التقاط الموقع إن أمكن (اختياري، دون إمساك المستخدم أو الإرسال).
        await tryCaptureGps(reportData);

        // V61: تنبيه التكرار المحتمل قبل فتح نافذة الحفظ.
        if (!editId) {
            const dupMsg = await findDuplicateReports(reportData);
            if (dupMsg && !confirm(dupMsg)) {
                isFormDirty = true;
                saveFormState();
                return;
            }
        }
        
        if (addAnother) {
            showToast('التقرير قيد الحفظ في الخلفية...');
        } else {
            document.querySelector('#successModal .fs-5').textContent = 'التقرير قيد الحفظ في الخلفية...';
            document.getElementById('success-spinner').style.display = 'inline-block';
            viewReportBtn.classList.add('disabled');
            successModal.show();
        }
        
        const saveOnlineOrQueue = async () => {
            // اكتب التقرير كاملاً في IndexedDB قبل أي طلب شبكة أو تفريغ للنموذج،
            // كي لا يضيع إذا أُغلق التطبيق قبل تأكيد الخادم.
            let pendingLocalId = '';
            try {
                pendingLocalId = await queueReportOffline(reportData, { registerSync: false });
                try {
                    if (localStorage.getItem(formStateKey()) === submittedDraftSnapshot) {
                        localStorage.removeItem(formStateKey());
                    }
                } catch (e) { /* يبقى التقرير كاملاً في IndexedDB */ }
                if (addAnother) resetFullForm();
            } catch (storageError) {
                // لا نمنع الإرسال المتصل في متصفح لا يدعم IndexedDB؛ تبقى
                // المسودة المحلية حتى ينجح الإرسال. دون اتصال لا نمسحها أبداً.
                if (!navigator.onLine) throw storageError;
                console.warn('تعذر إنشاء نسخة انتظار محلية قبل الإرسال:', storageError);
            }

            if (!navigator.onLine) {
                if (!pendingLocalId) throw new Error('تعذر حفظ التقرير محلياً؛ لم تُحذف المسودة. أعد المحاولة عند توفر التخزين.');
                registerBackgroundSync();
                return { queued: true, localId: pendingLocalId };
            }
            try {
                const result = await apiPost('submitReport', reportData);
                if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل الحفظ');
                if (pendingLocalId) {
                    try { await removePendingReport(pendingLocalId); }
                    catch (cleanupError) { console.warn('Report sent; pending copy cleanup will retry:', cleanupError); }
                } else {
                    try {
                        if (localStorage.getItem(formStateKey()) === submittedDraftSnapshot) {
                            localStorage.removeItem(formStateKey());
                        }
                    } catch (e) {}
                    if (addAnother) resetFullForm();
                }
                // Do NOT rebuild the whole master-data cache after every report.
                // Reports do not change Products/Locations/Employees, so a full refresh here
                // only adds a large network round-trip and JSON parsing cost. The server
                // invalidates the report cache on save; history will fetch the fresh report list
                // when opened. Keep the current in-memory product cache intact.
                invalidateReportsCache();
                window.dispatchEvent(new CustomEvent('reportsCacheInvalidated'));
                return result;
            } catch (error) {
                // في حالة انقطاع الشبكة أثناء الإرسال، خزّن التقرير للمزامنة.
                const networkFailure = !navigator.onLine || error instanceof TypeError ||
                    /failed to fetch|network|load failed/i.test(String(error.message || ''));
                if (networkFailure) {
                    if (pendingLocalId) {
                        registerBackgroundSync();
                        return { queued: true, localId: pendingLocalId };
                    }
                }
                // حتى أخطاء الخادم لا تحذف النسخة المحلية؛ تبقى ظاهرة في قائمة المزامنة.
                throw error;
            }
        };

        saveOnlineOrQueue()
            .then(result => {
                saveLastPoint(reportData);
                if (result.queued) {
                    updateOfflineStatus();
                    if (addAnother) {
                        showToast('تم حفظ التقرير محلياً وسيتم إرساله تلقائياً عند عودة الإنترنت.');
                    } else {
                        document.querySelector('#successModal .fs-5').textContent = 'تم حفظ التقرير محلياً — بانتظار الإنترنت للمزامنة';
                        document.getElementById('success-spinner').style.display = 'none';
                        viewReportBtn.classList.add('disabled');
                        successModal.show();
                    }
                    return;
                }

                spawnConfetti();

                if (addAnother) {
                    // resetFullForm() تم استدعاؤها مسبقاً، وتشمل تفريغ الأشخاص المتواجدين.
                    showToast('تم حفظ التقرير السابق بنجاح.');
                } else {
                    // بعد نجاح إرسال تقرير جديد فقط، نفرّغ الأشخاص المتواجدين ضمن النقطة.
                    // لا نفرّغ نموذج التعديل حتى يبقى التقرير المعروض كما هو.
                    if (!editId) {
                        setSelectedPromoters([]);
                        if (promotersSelectionTbody) {
                            promotersSelectionTbody.querySelectorAll('.promoter-checkbox').forEach(cb => {
                                cb.checked = false;
                            });
                        }
                    }
                    document.querySelector('#successModal .fs-5').textContent = 'تم حفظ التقرير بنجاح!';
                    document.getElementById('success-spinner').style.display = 'none';
                    viewReportBtn.href = '#/history';
                    sessionStorage.setItem('spaScrollReportId', String(result.reportId));
                    viewReportBtn.classList.remove('disabled');
                }
            })
            .catch(error => {
                isFormDirty = true;
                saveFormState();
                if (addAnother) {
                    showToast(`فشل حفظ التقرير: ${error.message}`, true);
                } else {
                    successModal.hide();
                    alert(`فشل إرسال التقرير: ${error.message}`);
                }
            });
    };
    
    const updateSalesVisibility = () => {
        const directPromotion = String($('#event').val() || '').trim() === 'ترويج مباشر';
        if (salesCard) salesCard.style.display = directPromotion ? 'none' : '';
        if (directPromotion) {
            salesTableBody.innerHTML = '';
            updateSaleTotals();
        }
    };

    const updateCompetitorSalesVisibility = () => {
        const visible = String($('#event').val() || '').trim() === 'ترويج مولات';
        if (competitorSalesCard) competitorSalesCard.style.display = visible ? '' : 'none';
        if (!visible && competitorSalesTableBody) competitorSalesTableBody.innerHTML = '';
    };

    const updateCompetitorSaleTotals = () => {
        if (!competitorSalesTableBody) return;
        competitorSalesTableBody.querySelectorAll('tr').forEach(row => {
            const price = Number(row.querySelector('.competitor-price')?.value) || 0;
            const qty = Number(row.querySelector('.competitor-quantity')?.value) || 0;
            const total = row.querySelector('.competitor-row-total');
            if (total) total.value = (price * qty).toFixed(2);
        });
        const rows = Array.from(competitorSalesTableBody.querySelectorAll('tr'));
        const totalQty = rows.reduce((sum,row)=>sum+(Number(row.querySelector('.competitor-quantity')?.value)||0),0);
        const grand = rows.reduce((sum,row)=>sum+(Number(row.querySelector('.competitor-price')?.value)||0)*(Number(row.querySelector('.competitor-quantity')?.value)||0),0);
        const tq=document.getElementById('competitorTotalQuantity'); if(tq) tq.textContent=totalQty;
        const gt=document.getElementById('competitorGrandTotal'); if(gt) gt.textContent=grand.toFixed(2);
    };

    const createCompetitorSaleRow = (sale = {}) => {
        const products = getCompetitorProducts();
        if (sale.product && !products.some(p => p.name === sale.product)) return;
        const row = document.createElement('tr');
        const productOptions = products.map(p => {
            const safeName = escapeHtml(String(p.name ?? ''));
            return `<option value="${safeName}" data-barcode="${escapeHtml(normalizeBarcode(p.barcode))}">${safeName}</option>`;
        }).join('');
        const price = sale.price !== undefined && sale.price !== '' ? Number(sale.price || 0).toFixed(2) : '';
        const qty = sale.quantity !== undefined && sale.quantity !== '' ? sale.quantity : '';
        row.innerHTML = `<td><select class="form-select form-select-sm competitor-product" required><option value="" selected disabled>اختر...</option>${productOptions}</select></td><td><input type="number" class="form-control form-control-sm competitor-price" value="${price}" step="0.01" min="0" required></td><td><input type="number" class="form-control form-control-sm competitor-quantity" value="${qty}" min="1" required></td><td><input type="text" class="form-control form-control-sm competitor-row-total" value="0.00" readonly></td><td><button type="button" class="btn btn-sm btn-outline-danger remove-competitor-row-btn"><i class="fa-solid fa-trash-can"></i></button></td>`;
        row.querySelector('.remove-competitor-row-btn').addEventListener('click', () => { row.remove(); updateCompetitorSaleTotals(); isFormDirty=true; saveFormState(); });
        row.querySelector('.competitor-price').addEventListener('input', () => { updateCompetitorSaleTotals(); isFormDirty=true; saveFormState(); });
        row.querySelector('.competitor-quantity').addEventListener('input', () => { updateCompetitorSaleTotals(); isFormDirty=true; saveFormState(); });
        row.querySelector('.competitor-product').addEventListener('change', () => { isFormDirty=true; saveFormState(); });
        competitorSalesTableBody.appendChild(row);
        if (sale.product) $(row.querySelector('.competitor-product')).val(sale.product).trigger('change');
        updateCompetitorSaleTotals();
    };

    const populateCompetitorProductModal = async () => {
        let products = getCompetitorProducts();

        // If the current browser cache does not contain competitor products,
        // fetch them directly from ProductsOfCompetitor.
        if (!products.length && navigator.onLine) {
            try {
                const freshProducts = await apiGet('getCompetitorProducts', { v: APP_DB_VERSION });
                if (Array.isArray(freshProducts)) {
                    DB.competitorProducts = freshProducts;
                    products = getCompetitorProducts();
                    localStorage.setItem(appDbCacheKey(), JSON.stringify(DB));
                    localStorage.setItem(appDbCacheTsKey(), String(Date.now()));
                }
            } catch (e) {
                console.warn('تعذر جلب مواد المنافس مباشرة:', e);
            }
        }

        competitorProductSelectionTbody.innerHTML = '';
        if (!products.length) {
            competitorProductSelectionTbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">لا توجد مواد في ProductsOfCompetitor</td></tr>';
        } else {
            products.forEach(p => competitorProductSelectionTbody.insertAdjacentHTML('beforeend', `<tr><td><div class="form-check"><input class="form-check-input competitor-product-select-check" type="checkbox" value="${escapeHtml(p.name)}" style="pointer-events:none;"></div></td><td>${escapeHtml(p.name)}</td></tr>`));
        }
        competitorProductSearchInput.value = '';
        competitorProductSearchInput.dispatchEvent(new Event('input'));
    };

    const addCompetitorProductByBarcode = (rawBarcode) => {
        const code = normalizeBarcode(rawBarcode);
        if (!code) return false;
        const product = getCompetitorProducts().find(p => normalizeBarcode(p.barcode) === code);
        const status = document.getElementById('competitorBarcodeStatus');
        if (!product) { if (status) { status.textContent=`الباركود ${code} غير موجود ضمن مواد المنافس.`; status.className='small mt-2 text-danger'; } showToast(`باركود المنافس ${code} غير موجود.`,true); return false; }
        const existing = Array.from(competitorSalesTableBody.querySelectorAll('tr')).find(r => $(r.querySelector('.competitor-product')).val()===product.name);
        if (existing) {
            const q=existing.querySelector('.competitor-quantity'); q.value=(parseInt(q.value,10)||0)+1;
        } else createCompetitorSaleRow({product:product.name,quantity:1});
        updateCompetitorSaleTotals();
        if(status){status.textContent=`تمت إضافة «${product.name}».`;status.className='small mt-2 text-success';}
        isFormDirty=true; saveFormState();
        const input=document.getElementById('competitorBarcodeInput'); if(input){input.value='';input.focus();}
        return true;
    };

    function setupModalRowClick(tbody) {
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('tr');
            if (!row) return;
            const checkbox = row.querySelector('.form-check-input');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
            }
        });
    }
    
    // لا تُترك النافذة فارغة بلا تفسير — كان الخطأ يظهر كقائمة اختيارات فارغة.
    const renderProductPicker = (tbody, products, buildRow, emptyMessage) => {
        tbody.innerHTML = '';
        if (!products.length) {
            tbody.innerHTML = `<tr><td colspan="2" class="text-center text-muted py-4">${emptyMessage}</td></tr>`;
            return;
        }
        products.forEach(product => tbody.insertAdjacentHTML('beforeend', buildRow(product)));
    };

    function populateProductSelectionModal(campaignName) {
        const products = getSaleProducts();
        renderProductPicker(productSelectionTbody, products, product => `<tr><td><div class="form-check"><input class="form-check-input product-select-check" type="checkbox" value="${product.name}" data-price="${getSaleDisplayPrice(product)}" style="pointer-events: none;"></div></td><td>${product.name}</td></tr>`, 'لا توجد مواد في ورقة Products. تأكد من إدخال اسم المادة.');
        productSearchInput.value = ''; productSearchInput.dispatchEvent(new Event('input'));
    }
    addSaleRowBtn.addEventListener('click', () => { const c = campaignSelect.value; if (!c) { alert('يرجى اختيار نوع الحملة أولاً.'); return; } populateProductSelectionModal(c); productModal.show(); });
    productSearchInput.addEventListener('input', () => { const s = productSearchInput.value.toLowerCase().trim(); productSelectionTbody.querySelectorAll('tr').forEach(r => { r.style.display = r.cells[1].textContent.toLowerCase().includes(s) ? '' : 'none'; }); });
    addSelectedProductsBtn.addEventListener('click', () => { productSelectionTbody.querySelectorAll('.product-select-check:checked').forEach(c => createSaleRow({ product: c.value, price: c.dataset.price })); updateSaleTotals(); productModal.hide(); isFormDirty = true; saveFormState(); });
    
    function populateExpenseSelectionModal(campaignName) {
        const products = getTastingProducts();
        renderProductPicker(expenseSelectionTbody, products, product => `<tr><td><div class="form-check"><input class="form-check-input expense-select-check" type="checkbox" value="${product.name}" style="pointer-events: none;"></div></td><td>${product.name}</td></tr>`, 'لا توجد مواد تذوق في ورقة Products. تأكد من إدخال اسم المادة.');
        expenseSearchInput.value = ''; expenseSearchInput.dispatchEvent(new Event('input'));
    }
    addExpenseRowBtn.addEventListener('click', () => { const c = campaignSelect.value; if (!c) { alert('يرجى اختيار نوع الحملة أولاً.'); return; } populateExpenseSelectionModal(c); expenseModal.show(); });
    expenseSearchInput.addEventListener('input', () => { const s = expenseSearchInput.value.toLowerCase().trim(); expenseSelectionTbody.querySelectorAll('tr').forEach(r => { r.style.display = r.cells[1].textContent.toLowerCase().includes(s) ? '' : 'none'; }); });
    addSelectedExpensesBtn.addEventListener('click', () => { expenseSelectionTbody.querySelectorAll('.expense-select-check:checked').forEach(c => createExpenseRow({ item: c.value })); expenseModal.hide(); isFormDirty = true; saveFormState(); });

    setupModalRowClick(productSelectionTbody);
    setupModalRowClick(expenseSelectionTbody);
    setupModalRowClick(competitorProductSelectionTbody);
    addCompetitorSaleRowBtn?.addEventListener('click', async () => { const c=campaignSelect.value; if(!c){alert('يرجى اختيار نوع الحملة أولاً.');return;} await populateCompetitorProductModal(); competitorProductModal.show(); });
    competitorProductSearchInput?.addEventListener('input', () => { const q=competitorProductSearchInput.value.toLowerCase().trim(); competitorProductSelectionTbody.querySelectorAll('tr').forEach(r => r.style.display=r.cells[1].textContent.toLowerCase().includes(q)?'':'none'); });
    addSelectedCompetitorProductsBtn?.addEventListener('click', () => { competitorProductSelectionTbody.querySelectorAll('.competitor-product-select-check:checked').forEach(c => createCompetitorSaleRow({product:c.value})); competitorProductModal.hide(); isFormDirty=true; saveFormState(); });
    
    const initEditMode = (report) => {
        populateSelect(governorateSelect, [...new Set(DB.locations.map(l => l.gov))], report.governorate);
        populateSelect(regionSelect, [...new Set(DB.locations.filter(l => l.gov === report.governorate).map(l => l.region))], report.region);
        populateSelect(marketSelect, [...new Set(DB.locations.filter(l => l.region === report.region).map(l => l.market))], report.market);
        $('#campaign').val(report.campaign).trigger('change');
        $('#event').val(report.event).trigger('change');
        document.getElementById('eventDays').value = report.eventDays;
        // القيم القادمة من Reports تكون بصيغة حقول HTML مباشرة.
        // يوجد fallback بسيط إذا أعاد Google Sheets قيمة Date/ISO.
        const toDateInputValue = (value) => {
            if (!value) return '';
            const text = String(value).trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
            const d = new Date(text);
            return Number.isNaN(d.getTime()) ? text : d.toISOString().slice(0, 10);
        };
        const toTimeInputValue = (value) => {
            if (!value) return '';
            const text = String(value).trim();
            const match = text.match(/^(\d{1,2}):(\d{2})/);
            if (match) return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
            const d = new Date(text);
            return Number.isNaN(d.getTime()) ? text : d.toTimeString().slice(0, 5);
        };
        document.getElementById('date').value = toDateInputValue(report.date);
        document.getElementById('timeFrom').value = toTimeInputValue(report.timeFrom);
        document.getElementById('timeTo').value = toTimeInputValue(report.timeTo);
        document.getElementById('notes').value = report.notes;
        if (document.getElementById('phoneNumber')) document.getElementById('phoneNumber').value = report.phoneNumber || '';
        applyGpsToFields(report.latitude, report.longitude);
        supervisorInput.value = report.supervisor || '';
        populateEmployees(report);
        originalCreatedAt = report.createdAt;
        salesTableBody.innerHTML = '';
        if (report.sales) report.sales.forEach(createSaleRow);
        updateSalesVisibility();
        if (competitorSalesTableBody) { competitorSalesTableBody.innerHTML = ''; if (report.salesOfCompetitor) report.salesOfCompetitor.forEach(createCompetitorSaleRow); updateCompetitorSaleTotals(); }
        updateCompetitorSalesVisibility();
        expensesTableBody.innerHTML = '';
        if (report.expenses) report.expenses.forEach(createExpenseRow);
        updateSaleTotals();
        mainSubmitBtn.innerHTML = '<i class="fa-solid fa-save"></i> تحديث التقرير';
        submitAndAddAnotherBtn.style.display = 'none';
        setTimeout(() => { isFormDirty = false; }, 200);
    };

    populateSelect(governorateSelect, [...new Set(DB.locations.map(l => l.gov))]);
    populateEmployees();
    reportForm.querySelectorAll('select:not(#market_name):not(.promoter-selector)').forEach(select => initSelect2(select, $(select).find("option:first").text(), false));
    
    $('#governorate').on('change', () => { const s = $('#governorate').val(); populateSelect(regionSelect, [...new Set(DB.locations.filter(l => l.gov === s).map(l => l.region))]); populateSelect(marketSelect, []); });
    $('#region').on('change', () => { const s = $('#region').val(); populateSelect(marketSelect, [...new Set(DB.locations.filter(l => l.region === s).map(l => l.market))]); });
    $('#inventoryDependency').on('change', function() { const s = $(this).val(); let n = ''; if (s) { const m = DB.employees.find(e => e.name === s); if (m && m.mgr) n = m.mgr; } supervisorInput.value = n; });
    $('#campaign').on('change', function() { salesTableBody.innerHTML = ''; expensesTableBody.innerHTML = ''; if (competitorSalesTableBody) competitorSalesTableBody.innerHTML = ''; updateCompetitorSalesVisibility(); updateSaleTotals(); const bi = document.getElementById('barcodeInput'); if (bi) bi.value = ''; const bs = document.getElementById('barcodeStatus'); if (bs) bs.textContent = ''; focusBarcodeInput(); });
    
    // const updatePhoneNumberRequirement = () => {
    //     const eventValue = String($('#event').val() || '').trim();
    //     const phoneInput = document.getElementById('phoneNumber');
    //     const hint = document.getElementById('phoneNumberHint');
    //     if (!phoneInput) return;
    //     const required = eventValue === 'ترويج وبيع غير مباشر';
    //     phoneInput.required = required;
    //     phoneInput.setAttribute('aria-required', required ? 'true' : 'false');
    //     if (hint) hint.textContent = required ? 'رقم هاتف صاحب المحل مطلوب لهذا النوع من الحدث.' : 'رقم الهاتف اختياري لهذا النوع من الحدث.';
    //     if (!required) phoneInput.setCustomValidity('');
    // };

    $('#event').on('change', function() {
       // updatePhoneNumberRequirement();
        updateSalesVisibility();
        updateCompetitorSalesVisibility();
        // أسعار المبيعات تعتمد على Products فقط في ترويج وبيع مباشر؛ وفي باقي الأحداث يجب على المستخدم إدخال السعر.
        salesTableBody.querySelectorAll('tr').forEach(row => { const sel=row.querySelector('.sale-product'); const name=String($(sel).val()||'').trim(); const master=getSaleProducts().find(p=>p.name===name); if(sel && master) row.querySelector('.sale-price').value = isDirectSaleEvent() ? Number(master.price||0).toFixed(2) : ''; });
        document.querySelectorAll('.sale-price, .competitor-price').forEach(input => input.setCustomValidity(''));
        updateSaleTotals();
        const isDirectPromotion = $(this).val() === 'ترويج مباشر';
        const marketSelectElement = $('#market_name');
        const currentValue = marketSelectElement.val();
        
        if (marketSelectElement.data('select2')) {
            marketSelectElement.select2('destroy');
        }
        
        initSelect2(marketSelectElement, 'اختر أو أدخل اسم المحل...', isDirectPromotion);
        marketSelectElement.val(currentValue).trigger('change');
    }).trigger('change');
    //updatePhoneNumberRequirement();
    updateSalesVisibility();

    // V58: في الـ SPA يُقرأ معرّف التعديل من تجزئة الرابط (#/reports?edit=) أو من
    // مؤشر التنقل بين الشاشات (window.__spaPendingEditId) — لم يعد هناك ?edit= في مسار الصفحة.
    const urlParams = (typeof queryFromHash === 'function') ? queryFromHash() : new URLSearchParams(window.location.search);
    let editId = urlParams.get('edit') || window.__spaPendingEditId || '';
    window.__spaPendingEditId = null;

    // الدخول في وضع التعديل — تستخدم عند أول فتح للشاشة وعند إعادة زيارتها من السجل.
    const enterEditMode = (id) => {
        editId = id;
        localStorage.removeItem(formStateKey());
        const reportFromState = JSON.parse(sessionStorage.getItem(reportToEditKey()));
        // الحالة المحلية تعرض التقرير فوراً، ثم الخادم يعيد أحدث نسخة دائماً.
        if (reportFromState && reportFromState.id == id) {
            initEditMode(reportFromState);
            sessionStorage.removeItem(reportToEditKey());
        }
        mainSubmitBtn.disabled = true;
        document.getElementById('edit-loading')?.remove();
        mainContainer.insertAdjacentHTML('afterbegin', `<div class="alert alert-info text-center p-3" id="edit-loading"><i class="fa-solid fa-spinner fa-spin"></i> مزامنة أحدث بيانات التقرير...</div>`);
        (async () => {
            try {
                const res = await apiGet('getReportById', { id: id });
                const result = await res;
                document.getElementById('edit-loading')?.remove();
                if (result.status === 'success') {
                    initEditMode(result.report);
                    mainSubmitBtn.disabled = false;
                } else throw new Error(result.message);
            } catch (error) {
                document.getElementById('edit-loading')?.remove();
                mainSubmitBtn.disabled = false;
                if (!reportFromState || reportFromState.id != id) alert(`خطأ في تحميل بيانات التعديل: ${error.message}`);
            }
        })();
    };

    if (editId) {
        enterEditMode(editId);
    } else {
        loadFormState();
    }

    // V58: إعادة دخول وضع التعديل عند الضغط على «تعديل» من السجل والشاشة مبنية أصلاً —
    // لأنه عند إعادة الزيارة لا يُعاد تشغيل handleReportPage بالكامل.
    window.addEventListener('spaViewRevisited', (event) => {
        if (event.detail && event.detail.route !== 'reports') return;
        if (window.__spaPendingEditId) {
            const pending = String(window.__spaPendingEditId);
            window.__spaPendingEditId = null;
            enterEditMode(pending);
        }
    });
    

    // ===============================================================
    //                  EXPENSE / TASTING BARCODE
    // ===============================================================
    const expenseBarcodeInput = document.getElementById('expenseBarcodeInput');
    const scanExpenseBarcodeCameraBtn = document.getElementById('scanExpenseBarcodeCameraBtn');
    const clearExpenseBarcodeBtn = document.getElementById('clearExpenseBarcodeBtn');
    let expenseBarcodeDebounceTimer = null;

    const findExpenseByBarcode = (barcode) => {
        const code = normalizeBarcode(barcode);
        if (!code) return null;
        return getTastingProducts().find(p => normalizeBarcode(p.barcode) === code) || null;
    };

    const findExpenseRowByProduct = (productName) => {
        return Array.from(expensesTableBody.querySelectorAll('tr')).find(row =>
            $(row.querySelector('.expense-item')).val() === productName
        ) || null;
    };

    const focusExpenseBarcodeInput = () => {
        if (expenseBarcodeInput) setTimeout(() => expenseBarcodeInput.focus(), 50);
    };

    const addProductToExpensesByBarcode = (rawBarcode) => {
        const barcode = normalizeBarcode(rawBarcode);
        const status = document.getElementById('expenseBarcodeStatus');
        if (!barcode) return false;

        if (!campaignSelect.value) {
            status.textContent = 'يرجى اختيار نوع الحملة أولاً.';
            status.className = 'small mt-2 text-danger';
            showToast('يرجى اختيار نوع الحملة أولاً.', true);
            focusExpenseBarcodeInput();
            return false;
        }

        const product = findExpenseByBarcode(barcode);
        if (!product) {
            status.textContent = `الباركود ${barcode} غير موجود ضمن مواد التذوق للحملة الحالية.`;
            status.className = 'small mt-2 text-danger';
            showToast(`الباركود ${barcode} غير موجود ضمن مواد التذوق.`, true);
            focusExpenseBarcodeInput();
            return false;
        }

        const existingRow = findExpenseRowByProduct(product.name);
        if (existingRow) {
            const quantityInput = existingRow.querySelector('.expense-quantity');
            quantityInput.value = (parseInt(quantityInput.value, 10) || 0) + 1;
            status.textContent = `تمت زيادة كمية «${product.name}» إلى ${quantityInput.value}.`;
        } else {
            createExpenseRow({ item: product.name, quantity: 1, barcode });
            status.textContent = `تمت إضافة «${product.name}» × 1.`;
        }

        status.className = 'small mt-2 text-success';
        isFormDirty = true;
        saveFormState();
        expenseBarcodeInput.value = '';
        focusExpenseBarcodeInput();
        return true;
    };

    document.getElementById('competitorBarcodeInput')?.addEventListener('keydown', e => { if(e.key==='Enter'){ e.preventDefault(); clearTimeout(barcodeDebounceTimer); addCompetitorProductByBarcode(e.currentTarget.value); } });
    document.getElementById('competitorBarcodeInput')?.addEventListener('input', e => { clearTimeout(barcodeDebounceTimer); const value=normalizeBarcode(e.currentTarget.value); if(value.length<6)return; barcodeDebounceTimer=setTimeout(()=>{ if(document.activeElement===e.currentTarget && normalizeBarcode(e.currentTarget.value).length>=6) addCompetitorProductByBarcode(e.currentTarget.value); },250); });

    // ===============================================================
    //                 USB SCANNER + CAMERA SCANNER
    // ===============================================================
    const barcodeInput = document.getElementById('barcodeInput');
    const scanBarcodeCameraBtn = document.getElementById('scanBarcodeCameraBtn');
    const clearBarcodeBtn = document.getElementById('clearBarcodeBtn');
    const barcodeCameraModalElement = document.getElementById('barcodeCameraModal');
    const barcodeCameraModal = new bootstrap.Modal(barcodeCameraModalElement);
    let html5QrCode = null;
    let barcodeDebounceTimer = null;
    let lastSalesBarcode = '';
    let lastSalesBarcodeAt = 0;
    let cameraScanLocked = false;
    let cameraTarget = 'sales';

    const stopBarcodeCamera = async () => {
        if (!html5QrCode) return;
        try {
            const state = html5QrCode.getState?.();
            if (state === 2) await html5QrCode.stop();
        } catch (error) { console.warn('Barcode camera stop:', error); }
        try { await html5QrCode.clear(); } catch (error) {}
        html5QrCode = null;
        cameraScanLocked = false;
    };

    const handleScannedBarcode = (decodedText) => {
        if (cameraScanLocked) return;
        const barcode = normalizeBarcode(decodedText);
        if (!barcode) return;

        cameraScanLocked = true;
        const added = cameraTarget === 'expense'
            ? addProductToExpensesByBarcode(barcode)
            : cameraTarget === 'competitor'
                ? addCompetitorProductByBarcode(barcode)
                : addProductToSalesByBarcode(barcode);

        const status = document.getElementById('cameraScannerStatus');
        status.textContent = added ? 'تمت إضافة المادة. سيتم إغلاق الكاميرا...' : 'لم يتم العثور على المادة.';
        setTimeout(async () => {
            await stopBarcodeCamera();
            barcodeCameraModal.hide();
            cameraScanLocked = false;
        }, added ? 350 : 900);
    };

    const startBarcodeCamera = async (target = 'sales') => {
        cameraTarget = target;
        const status = document.getElementById('cameraScannerStatus');

        if (typeof Html5Qrcode === 'undefined') {
            if (!navigator.onLine) {
                const msg = 'مكتبة قراءة الباركود بالكاميرا تحتاج اتصالاً بالإنترنت لتحميلها أول مرة.';
                status.textContent = msg;
                showToast(msg, true);
                barcodeCameraModal.show();
                return;
            }
            status.textContent = 'جاري تحميل مكتبة الكاميرا...';
            barcodeCameraModal.show();
            const loaded = await loadHtml5QrcodeLibrary();
            if (!loaded || typeof Html5Qrcode === 'undefined') {
                const msg = 'تعذر تحميل مكتبة قراءة الباركود بالكاميرا. تحقق من الاتصال وحاول مجدداً.';
                status.textContent = msg;
                showToast(msg, true);
                return;
            }
        }
        if (!campaignSelect.value) {
            showToast('يرجى اختيار نوع الحملة أولاً.', true);
            return;
        }
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            const msg = 'الكاميرا تحتاج HTTPS أو localhost.';
            status.textContent = msg;
            showToast(msg, true);
            barcodeCameraModal.show();
            return;
        }

        cameraScanLocked = false;
        status.textContent = target === 'expense'
            ? 'جاري تجهيز الكاميرا لمواد التذوق...'
            : target === 'competitor'
                ? 'جاري تجهيز الكاميرا لمواد المنافس...'
                : 'جاري تجهيز الكاميرا للمواد البيعية...';
        barcodeCameraModal.show();

        const scannerConfig = {
            fps: 10,
            qrbox: { width: 280, height: 140 },
            formatsToSupport: [
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.CODE_39,
                Html5QrcodeSupportedFormats.CODE_93,
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
                Html5QrcodeSupportedFormats.ITF,
                Html5QrcodeSupportedFormats.CODABAR
            ]
        };

        try {
            // لا نستخدم facingMode نهائياً. نطلب الكاميرات ونمرر cameraId مباشرة.
            const cameras = await Html5Qrcode.getCameras();
            if (!cameras || cameras.length === 0) {
                throw new DOMException('لم يتم العثور على كاميرا متاحة.', 'NotFoundError');
            }

            // html5-qrcode 2.3.8 expects a non-empty camera id string.
            // Some browsers expose the device id as `deviceId` instead of `id`,
            // so normalize all common shapes before calling start().
            const normalizedCameras = cameras.map(camera => {
                const isString = typeof camera === 'string';
                return {
                    raw: camera,
                    id: String(
                        isString
                            ? camera
                            : (camera?.id ??
                               camera?.deviceId ??
                               camera?.cameraId ??
                               '')
                    ).trim(),
                    label: String(isString ? '' : (camera?.label || '')).trim()
                };
            }).filter(camera => camera.id);

            if (!normalizedCameras.length) {
                throw new DOMException(
                    'لم يتمكن المتصفح من توفير معرف للكاميرا.',
                    'NotFoundError'
                );
            }

            const selectedCamera =
                normalizedCameras.find(camera => {
                    const label = camera.label.toLowerCase();
                    return label.includes('back') ||
                           label.includes('rear') ||
                           label.includes('environment') ||
                           label.includes('خلف');
                }) || normalizedCameras[0];

            const cameraId = selectedCamera.id;

            // Safety check: never call start() with an empty/undefined camera id.
            if (typeof cameraId !== 'string' || !cameraId.trim()) {
                throw new DOMException(
                    'معرف الكاميرا غير صالح.',
                    'NotFoundError'
                );
            }

            html5QrCode = new Html5Qrcode('barcode-reader', { verbose: false });

            await html5QrCode.start(
                cameraId,
                scannerConfig,
                handleScannedBarcode,
                () => {}
            );

            status.textContent = target === 'expense'
                ? 'وجّه الكاميرا نحو باركود مادة التذوق'
                : 'وجّه الكاميرا نحو باركود المادة البيعية';
        } catch (error) {
            console.error('Barcode camera error:', error);
            let message = `تعذر تشغيل الكاميرا: ${error?.name || ''} ${error?.message || error}`;

            if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
                message = 'تم رفض إذن الكاميرا. اسمح للمتصفح باستخدام الكاميرا ثم أعد المحاولة.';
            } else if (error?.name === 'NotFoundError') {
                message = 'لم يتم العثور على كاميرا متاحة على الجهاز.';
            } else if (error?.name === 'NotReadableError' || error?.name === 'AbortError') {
                message = 'الكاميرا مستخدمة من تطبيق أو صفحة أخرى. أغلقها ثم أعد المحاولة.';
            }

            status.textContent = message;
            showToast(message, true);
            await stopBarcodeCamera();
        }
    };

    scanBarcodeCameraBtn.addEventListener('click', () => startBarcodeCamera('sales'));
    scanExpenseBarcodeCameraBtn?.addEventListener('click', () => startBarcodeCamera('expense'));
    document.getElementById('scanCompetitorBarcodeCameraBtn')?.addEventListener('click', () => startBarcodeCamera('competitor'));

    clearBarcodeBtn.addEventListener('click', () => {
        barcodeInput.value = '';
        document.getElementById('barcodeStatus').textContent = '';
        focusBarcodeInput();
    });
    clearExpenseBarcodeBtn?.addEventListener('click', () => {
        expenseBarcodeInput.value = '';
        document.getElementById('expenseBarcodeStatus').textContent = '';
        focusExpenseBarcodeInput();
    });
    document.getElementById('clearCompetitorBarcodeBtn')?.addEventListener('click', () => { const input=document.getElementById('competitorBarcodeInput'); if(input){input.value='';input.focus();} document.getElementById('competitorBarcodeStatus').textContent=''; });

    barcodeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(barcodeDebounceTimer);
            addProductToSalesByBarcode(barcodeInput.value);
        }
    });
    barcodeInput.addEventListener('input', () => {
        clearTimeout(barcodeDebounceTimer);
        const value = normalizeBarcode(barcodeInput.value);
        if (value.length < 6) return;
        barcodeDebounceTimer = setTimeout(() => {
            if (document.activeElement === barcodeInput && normalizeBarcode(barcodeInput.value).length >= 6)
                addProductToSalesByBarcode(barcodeInput.value);
        }, 250);
    });

    expenseBarcodeInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(expenseBarcodeDebounceTimer);
            addProductToExpensesByBarcode(expenseBarcodeInput.value);
        }
    });
    expenseBarcodeInput?.addEventListener('input', () => {
        clearTimeout(expenseBarcodeDebounceTimer);
        const value = normalizeBarcode(expenseBarcodeInput.value);
        if (value.length < 6) return;
        expenseBarcodeDebounceTimer = setTimeout(() => {
            if (document.activeElement === expenseBarcodeInput && normalizeBarcode(expenseBarcodeInput.value).length >= 6)
                addProductToExpensesByBarcode(expenseBarcodeInput.value);
        }, 250);
    });

    barcodeCameraModalElement.addEventListener('hidden.bs.modal', async () => {
        await stopBarcodeCamera();
    });

    setTimeout(focusBarcodeInput, 300);

    salesTableBody.addEventListener('input', updateSaleTotals);
    reportForm.addEventListener('submit', (event) => handleFormSubmit(event, editId, false));
    submitAndAddAnotherBtn.addEventListener('click', (event) => handleFormSubmit(event, editId, true));
    
    document.getElementById('successModal').addEventListener('hidden.bs.modal', () => {
        if (!editId) { // فقط إذا كان تقريرًا جديدًا
            resetFullForm();
        } else {
            // V58: الخروج من وضع التعديل لتصبح الشاشة جاهزة لتقرير جديد — دون إعادة تحميل الصفحة.
            editId = '';
            sessionStorage.removeItem(reportToEditKey());
            resetFullForm();
        }
    });

    // اختصار لوحة المفاتيح: Ctrl+S / Cmd+S لإرسال التقرير.
    document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
            event.preventDefault();
            if (confirm('إرسال التقرير الآن؟')) reportForm.requestSubmit();
        }
    });
}

// V58: تسجيل شاشة التقارير في موجه الـ SPA.
if (typeof registerView === 'function') registerView('reports', handleReportPage);
