// ===================================================================
//                      5. منطق صفحة سجل التعديلات
// ===================================================================
async function handleHistoryPage() {
    const reportsAccordion = document.getElementById('reports-accordion');
    const searchInput = document.getElementById('searchInput');
    const noResultsMessage = document.getElementById('no-results-message');
    const reportsCount = document.getElementById('reportsCount');
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    let currentReports = [];
    const userRole = String(currentUser?.role || '').trim().toLowerCase();
    const isAdmin = userRole === 'admin';
    const isManager = userRole === 'manager';
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

    const renderReports = (reportsToRender) => {
        reportsAccordion.innerHTML = '';
        const count = Array.isArray(reportsToRender) ? reportsToRender.length : 0;
        if (reportsCount) reportsCount.textContent = `${count} تقرير${count === 1 ? '' : ''}`;
        if (!reportsToRender || reportsToRender.length === 0) {
            noResultsMessage.textContent = searchInput.value ? 'لا توجد تقارير تطابق بحثك.' : 'لا توجد تقارير محفوظة لعرضها.';
            noResultsMessage.classList.remove('d-none');
            return;
        }
        noResultsMessage.classList.add('d-none');
        reportsToRender.slice().reverse().forEach(report => {
            let grandTotal = 0, totalQuantity = 0;
            const salesRows = report.sales?.length > 0 ? report.sales.map(s => { 
                const p = parseFloat(s.price) || 0;
                const q = parseInt(s.quantity) || 0;
                const t = p * q; 
                grandTotal += t; 
                totalQuantity += q; 
                return `<tr><td>${s.product||'-'}</td><td>${p.toFixed(2)}</td><td>${q}</td><td>${t.toFixed(2)}</td></tr>`; 
            }).join('') : '<tr><td colspan="4" class="text-center text-muted">لا توجد مبيعات</td></tr>';
            const expensesRows = report.expenses?.length > 0 ? report.expenses.map(exp => `<tr><td>${exp.item || '-'}</td><td>${exp.quantity || '0'}</td></tr>`).join('') : '<tr><td colspan="2" class="text-center text-muted">لا توجد مصاريف</td></tr>';
            const competitorSalesRows = report.salesOfCompetitor?.length > 0 ? report.salesOfCompetitor.map(s => `<tr><td>${s.product||'-'}</td><td>${Number(s.price||0).toFixed(2)}</td><td>${s.quantity||0}</td></tr>`).join('') : '<tr><td colspan="3" class="text-center text-muted">لا توجد مبيعات منافس</td></tr>';
            const promotersList = report.promoters && report.promoters.length > 0 ? report.promoters.join(', ') : 'لا يوجد';
            const reportHTML = `<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#c-${report.id}"><strong>${report.campaign} - ${report.market}</strong> (${report.date})</button></h2><div id="c-${report.id}" class="accordion-collapse collapse" data-bs-parent="#reports-accordion"><div class="accordion-body"><p><strong>تاريخ الإنشاء:</strong> ${report.createdAt || 'غير مسجل'}</p><p><strong>الحدث:</strong> ${report.event} (${report.eventDays} أيام) | <strong>الوقت:</strong> ${report.timeFrom} - ${report.timeTo}</p><p><strong>الفريق:</strong> منسق (${report.coordinator || 'N/A'})، جرد (${report.inventoryDependency || 'N/A'})، مشرف (${report.supervisor || 'N/A'})</p><p><strong>المروجون:</strong> ${promotersList}</p><h5 class="mt-4">المبيعات</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead><tbody>${salesRows}</tbody>${report.sales?.length > 0 ? `<tfoot class="table-light fw-bold"><tr><td class="text-end" colspan="2">الإجمالي:</td><td>${totalQuantity}</td><td>${grandTotal.toFixed(2)}</td></tr></tfoot>` : ''}</table><h5 class="mt-4">مبيعات المنافس</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>السعر</th><th>الكمية</th></tr></thead><tbody>${competitorSalesRows}</tbody></table><h5 class="mt-4">المصاريف</h5><table class="table table-sm table-bordered"><thead><tr><th>المادة</th><th>الكمية</th></tr></thead><tbody>${expensesRows}</tbody></table>${report.notes ? `<hr><p><strong>ملاحظات:</strong> ${report.notes}</p>` : ''}<div class="text-end mt-3 border-top pt-3"><a href="reports.html?edit=${report.id}" class="btn btn-sm btn-primary edit-report-btn" data-report-id="${report.id}"><i class="fa-solid fa-pen-to-square me-1"></i> تعديل</a></div></div></div></div>`;
            reportsAccordion.insertAdjacentHTML('beforeend', reportHTML);
        });
        reportsAccordion.querySelectorAll('.edit-report-btn').forEach(button => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                const reportId = button.getAttribute('data-report-id');
                const reportData = currentReports.find(r => r.id == reportId);
                if (reportData) {
                    sessionStorage.setItem(EDIT_STATE_KEY, JSON.stringify(reportData));
                }
                window.location.href = button.href;
            });
        });
        
        if (window.location.hash) {
            const targetId = window.location.hash.substring(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                new bootstrap.Collapse(targetElement).show();
                targetElement.scrollIntoView({ behavior: 'smooth' });
            }
        }
    };

    // جلب تقارير من الخادم — targetId = 'all' (النطاق الافتراضي حسب الصلاحية) أو معرّف موظف محدد.
    async function fetchReportsFromServer(targetId) {
        const params = new URLSearchParams({
            action: 'getReports',
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || ''),
            targetUserId: String(targetId || 'all'),
            _: String(Date.now())
        });
        const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error(data?.message || 'استجابة غير صالحة من الخادم');
        return data;
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
                if (selectedTargetId === 'all') {
                    currentReports = memoryReportsCache || [];
                    renderReports(currentReports);
                    return;
                }
                reportsAccordion.innerHTML = `<div class="text-center p-4"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
                try {
                    currentReports = await fetchReportsFromServer(selectedTargetId);
                    renderReports(currentReports);
                } catch (e) {
                    reportsAccordion.innerHTML = `<div class="alert alert-danger">تعذر تحميل بيانات هذا الموظف.</div>`;
                }
            });
        }
    }

    const cachedReportsJSON = memoryReportsCache ? null : localStorage.getItem('reportsCache');
    if (memoryReportsCache) {
        currentReports = memoryReportsCache;
        renderReports(currentReports);
    } else if (cachedReportsJSON) {
        try {
            const allCachedReports = JSON.parse(cachedReportsJSON);
            if (Array.isArray(allCachedReports)) {
                currentReports = allCachedReports;
                renderReports(currentReports);
            }
        } catch (e) {
            localStorage.removeItem('reportsCache');
        }
    }
    if (!cachedReportsJSON) {
        reportsAccordion.innerHTML = `<div class="p-2"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>`;
    }

    // V27: debounce لتقليل عمليات إعادة الرسم أثناء الكتابة السريعة في قائمة طويلة من التقارير.
    let searchDebounceTimer = null;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        const value = e.target.value;
        searchDebounceTimer = setTimeout(() => {
            const term = value.toLowerCase().trim();
            if (!term) { renderReports(currentReports); return; }
            const filtered = currentReports.filter(r => {
                const haystack = r.__searchText || (r.__searchText = `${r.campaign||''} ${r.market||''} ${r.date||''} ${r.supervisor||''}`.toLowerCase());
                return haystack.includes(term);
            });
            renderReports(filtered);
        }, 150);
    });

    try {
        // النطاق الافتراضي (بدون تحديد موظف) — يحسمه الخادم حسب الدور: admin=الكل، manager=فريقه، user=نفسه.
        const allFreshReports = await fetchReportsFromServer('all');
        memoryReportsCache = allFreshReports;
        localStorage.setItem('reportsCache', JSON.stringify(allFreshReports));
        if (selectedTargetId === 'all') {
            currentReports = allFreshReports;
            renderReports(currentReports);
        }
    } catch (error) {
        if (!cachedReportsJSON) {
            reportsAccordion.innerHTML = `<div class="alert alert-danger">فشل تحميل سجل التقارير. يرجى التحقق من الاتصال وبيانات المستخدم ثم تحديث الصفحة.</div>`;
        }
    }

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
}
