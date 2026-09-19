// ===================================================================
//   5.5 منطق صفحة التحليلات (dashboard.html) — رسوم بيانية وإحصائيات
// ===================================================================

async function handleDashboardPage() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    if (!currentUser) { window.location.href = 'index.html'; return; }

    // V42: صلاحية صفحة التحليلات — admin و manager فقط (المدير يرى فريقه، الإداري الكل).
    // أي مستخدم آخر يُعاد إلى صفحة التقارير حتى لو فتح الرابط مباشرة.
    const role = String(currentUser.role || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'manager') {
        window.location.href = 'reports.html';
        return;
    }

    let db = null;
    try { db = await getDbData(); } catch (e) { db = { locations: [], products: {}, employees: [] }; }

    const campaignFilter = document.getElementById('dashboardCampaignFilter');
    const toastContainer = document.getElementById('toast-notification');
    const showToast = (msg, isError = false) => {
        const tm = toastContainer?.querySelector('.toast-message');
        if (!tm) return;
        tm.textContent = msg;
        tm.classList.toggle('error', isError);
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 3000);
    };

    const campaignNames = new Set();
    Object.keys(db.products || {}).forEach(c => { if (c) campaignNames.add(c); });
    db.locations?.forEach(l => { if (l?.gov) campaignNames.add(''); });
    if (campaignFilter) {
        campaignFilter.innerHTML = '<option value="">كل الحملات</option>' +
            [...campaignNames].filter(Boolean).sort().map(c => `<option value="${c}">${c}</option>`).join('');
    }

    let charts = {};
    const textColor = () => getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#333';
    const gridColor = () => getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#dfe7f1';

    function destroyCharts() {
        Object.values(charts).forEach(c => { try { c?.destroy(); } catch (e) {} });
        charts = {};
    }

    function loadReports() {
        return new Promise(async (resolve, reject) => {
            try {
                const params = new URLSearchParams({
                    action: 'getReports',
                    userId: String(currentUser.id || ''),
                    role: String(currentUser.role || ''),
                    userName: String(currentUser.name || ''),
                    _: String(Date.now())
                });
                const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
                const data = await res.json();
                resolve(Array.isArray(data) ? data : []);
            } catch (e) { resolve([]); }
        });
    }

    // V42: جلب الإحصائيات المجمّعة من الخادم (أسرع بكثير من جلب كل التقارير وتجميعها محلياً).
    // مع fallback تلقائي إلى التجميع المحلي إذا فشل استدعاء getDashboardData.
    async function loadDashboardStats() {
        if (!navigator.onLine) return null;
        try {
            const params = new URLSearchParams({
                action: 'getDashboardData',
                userId: String(currentUser.id || ''),
                role: String(currentUser.role || ''),
                _: String(Date.now())
            });
            const res = await fetch(`${SCRIPT_URL}?${params.toString()}`, { cache: 'no-store' });
            const data = await res.json();
            if (data && data.status === 'success' && data.kpis) return data;
            return null;
        } catch (e) {
            console.warn('تعذر جلب بيانات التحليلات المجمعة، سيتم التجميع محلياً:', e);
            return null;
        }
    }

    async function refreshDashboard() {
        destroyCharts();
        const campaign = campaignFilter?.value || '';
        const stats = await loadDashboardStats();

        if (stats && !campaign) {
            // نستخدم البيانات المجمّعة من الخادم عند عدم وجود فلتر حملة.
            renderFromServerStats(stats);
            return;
        }

        // فلترة حسب الحملة أو fallback: التجميع المحلي.
        const reports = campaign ? await loadReports() : [];
        const baseReports = stats && !campaign ? [] : (reports.length ? reports : await loadReports());
        const filtered = reports.length ? reports.filter(r => String(r.campaign || '') === campaign) : baseReports;
        renderClientSide(filtered, db);
    }

    function renderFromServerStats(stats) {
        const kpis = stats.kpis || {};
        const kpiReports = document.getElementById('kpiTotalReports');
        const kpiSales = document.getElementById('kpiTotalSales');
        const kpiEmployees = document.getElementById('kpiActiveEmployees');
        const kpiProducts = document.getElementById('kpiTotalProducts');
        if (kpiReports) kpiReports.textContent = kpis.totalReports || 0;
        if (kpiSales) kpiSales.textContent = (kpis.totalSales || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (kpiEmployees) kpiEmployees.textContent = kpis.activeEmployees || 0;
        if (kpiProducts) kpiProducts.textContent = Object.values(db.products || {}).flat().length || 0;

        // Daily line
        const dailyCtx = document.getElementById('chartDailySales');
        if (dailyCtx && typeof Chart !== 'undefined' && Array.isArray(stats.daily)) {
            charts.daily = new Chart(dailyCtx.getContext('2d'), {
                type: 'line',
                data: {
                    labels: stats.daily.map(d => String(d.date).slice(5)),
                    datasets: [{
                        label: 'المبيعات (بالمليون)',
                        data: stats.daily.map(d => (d.value || 0) / 1000000),
                        borderColor: '#4a90e2',
                        backgroundColor: 'rgba(74,144,226,0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2
                    }]
                },
                options: baseChartOptions('إجمالي المبيعات اليومية بالل.ل', textColor(), gridColor())
            });
        }

        // Campaign pie
        const pieCtx = document.getElementById('chartCampaignPie');
        if (pieCtx && typeof Chart !== 'undefined' && Array.isArray(stats.campaigns)) {
            charts.pie = new Chart(pieCtx.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: stats.campaigns.map(c => c.label),
                    datasets: [{
                        data: stats.campaigns.map(c => c.value),
                        backgroundColor: ['#4a90e2','#50e3c2','#f39c12','#e74c3c','#9b59b6','#1abc9c','#f1c40f'],
                        borderWidth: 1
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: textColor() } } } }
            });
        }

        // Governorate bar
        const govCtx = document.getElementById('chartGovernorateBar');
        if (govCtx && typeof Chart !== 'undefined' && Array.isArray(stats.governorates)) {
            charts.gov = new Chart(govCtx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: stats.governorates.map(g => g.label),
                    datasets: [{
                        label: 'المبيعات بالمليون',
                        data: stats.governorates.map(g => Math.round((g.value / 1000000) * 100) / 100),
                        backgroundColor: 'rgba(80,227,194,0.7)',
                        borderColor: '#50e3c2',
                        borderWidth: 1
                    }]
                },
                options: baseChartOptions('المبيعات بالمليون الليرة', textColor(), gridColor())
            });
        }

        // Employees
        const body = document.getElementById('employeePerformanceBody');
        if (body) {
            const list = Array.isArray(stats.employees) ? stats.employees : [];
            const totalSales = list.reduce((s, e) => s + (e.sales || 0), 0);
            body.innerHTML = list.length ? list.map(e => {
                const pct = totalSales ? Math.round((e.sales / totalSales) * 100) : 0;
                return `<tr><td><span class="fw-bold">${escapeHtmlGlobal(e.name)}</span></td><td>${e.reports || 0}</td><td>${(e.sales || 0).toLocaleString('en-US', { minimumFractionDigits: 0 })} <span class="badge bg-secondary ms-1">${pct}%</span></td></tr>`;
            }).join('') : '<tr><td colspan="3" class="text-center text-muted py-4">لا توجد بيانات</td></tr>';
        }
    }

    function renderClientSide(reports, db) {
        const txt = () => getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#333';
        const grd = () => getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#dfe7f1';
        const filtered = reports || [];

        let totalSales = 0, totalQty = 0;
        const employeesSet = new Set();
        filtered.forEach(r => {
            (r.sales || []).forEach(s => {
                totalSales += (Number(s.price) || 0) * (Number(s.quantity) || 0);
                totalQty += Number(s.quantity) || 0;
            });
            if (r.createdByName) employeesSet.add(r.createdByName);
        });
        const kpiReports = document.getElementById('kpiTotalReports');
        const kpiSales = document.getElementById('kpiTotalSales');
        const kpiEmployees = document.getElementById('kpiActiveEmployees');
        const kpiProducts = document.getElementById('kpiTotalProducts');
        if (kpiReports) kpiReports.textContent = filtered.length || 0;
        if (kpiSales) kpiSales.textContent = totalSales.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (kpiEmployees) kpiEmployees.textContent = employeesSet.size || 0;
        if (kpiProducts) kpiProducts.textContent = Object.values(db.products || {}).flat().length || 0;

        const dailyMap = new Map();
        const today = new Date();
        for (let i = 29; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); dailyMap.set(d.toISOString().slice(0,10), 0); }
        filtered.forEach(r => { const key = String(r.date || '').slice(0,10); if (dailyMap.has(key)) { let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); dailyMap.set(key,(dailyMap.get(key)||0)+sum); } });

        const dailyCtx = document.getElementById('chartDailySales');
        if (dailyCtx && typeof Chart !== 'undefined') {
            charts.daily = new Chart(dailyCtx.getContext('2d'), {
                type: 'line',
                data: { labels: [...dailyMap.keys()].map(k=>k.slice(5)), datasets: [{ label:'المبيعات (بالمليون)', data:[...dailyMap.values()].map(v=>v/1000000), borderColor:'#4a90e2', backgroundColor:'rgba(74,144,226,0.1)', fill:true, tension:0.3, pointRadius:2 }] },
                options: baseChartOptions('إجمالي المبيعات اليومية بالل.ل', txt(), grd())
            });
        }

        const campMap = new Map();
        filtered.forEach(r => { const c=String(r.campaign||'غير محدد'); let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); campMap.set(c,(campMap.get(c)||0)+sum); });
        const pieCtx = document.getElementById('chartCampaignPie');
        if (pieCtx && typeof Chart !== 'undefined') {
            const d=[...campMap.entries()];
            charts.pie = new Chart(pieCtx.getContext('2d'), { type:'doughnut', data:{ labels:d.map(([k])=>k), datasets:[{ data:d.map(([,v])=>v), backgroundColor:['#4a90e2','#50e3c2','#f39c12','#e74c3c','#9b59b6','#1abc9c','#f1c40f'], borderWidth:1 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ color:txt() } } } } });
        }

        const govMap = new Map();
        filtered.forEach(r => { const g=String(r.governorate||'غير محدد'); let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); govMap.set(g,(govMap.get(g)||0)+sum); });
        const govCtx = document.getElementById('chartGovernorateBar');
        if (govCtx && typeof Chart !== 'undefined') {
            const d=[...govMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
            charts.gov = new Chart(govCtx.getContext('2d'), { type:'bar', data:{ labels:d.map(([k])=>k), datasets:[{ label:'المبيعات', data:d.map(([,v])=>Math.round(v/1000000*100)/100), backgroundColor:'rgba(80,227,194,0.7)', borderColor:'#50e3c2', borderWidth:1 }] }, options: baseChartOptions('المبيعات بالمليون الليرة', txt(), grd()) });
        }

        renderEmployeePerformance(filtered, db);
    }

    function employeePerformance(reports) {
        const map = new Map();
        let productCount = 0;
        (reports || []).forEach(r => {
            const name = String(r.createdByName || 'غير معروف');
            if (!map.has(name)) map.set(name, { name, reports: 0, sales: 0 });
            const e = map.get(name);
            e.reports++;
            let sum = 0;
            (r.sales || []).forEach(s => sum += (Number(s.price) || 0) * (Number(s.quantity) || 0));
            e.sales += sum;
        });
        const list = [...map.values()].sort((a,b) => b.sales - a.sales).slice(0, 15);
        return { list, productCount };
    }

    function renderEmployeePerformance(reports, db) {
        const body = document.getElementById('employeePerformanceBody');
        if (!body) return;
        const { list } = employeePerformance(reports);
        const dbProducts = Object.values(db.products || {}).flat().length;
        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-4">لا توجد بيانات</td></tr>';
            return;
        }
        const totalSales = list.reduce((s, e) => s + e.sales, 0);
        body.innerHTML = list.map(e => {
            const pct = totalSales ? Math.round((e.sales / totalSales) * 100) : 0;
            return `<tr>
                <td><span class="fw-bold">${escapeHtmlGlobal(e.name)}</span>${dbProducts ? `<span class="text-muted small"> (${dbProducts} مادة)</span>` : ''}</td>
                <td>${e.reports}</td>
                <td>${e.sales.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} <span class="badge bg-secondary ms-1">${pct}%</span></td>
            </tr>`;
        }).join('');
    }

    function baseChartOptions(title, textColor, gridColor) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: textColor } },
                title: { display: !!title, text: title, color: textColor }
            },
            scales: {
                x: { ticks: { color: textColor, maxTicksLimit: 10 }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor } }
            }
        };
    }

    // Re-render charts on theme change for correct colors.
    const themeObserver = new MutationObserver(() => refreshDashboard());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    campaignFilter?.addEventListener('change', refreshDashboard);

    const exportBtn = document.getElementById('exportDashboardCSV');
    exportBtn?.addEventListener('click', async () => {
        const reports = await loadReports();
        const campaign = campaignFilter?.value || '';
        const filtered = campaign ? reports.filter(r => String(r.campaign || '') === campaign) : reports;
        const csv = reportsToCSV(filtered);
        downloadTextFile(`reports_${campaign || 'all'}_${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
        showToast('تم تصدير CSV بنجاح.');
    });

    // V44: أرشفة التقارير القديمة — متاحة فقط لحساب admin (عملية شاملة على كل التقارير
    // بغض النظر عن الفريق، فلا معنى لإتاحتها لحساب manager).
    const archiveCardWrap = document.getElementById('archiveCardWrap');
    if (role === 'admin' && archiveCardWrap) {
        archiveCardWrap.classList.remove('d-none');
        const archiveBtn = document.getElementById('archiveOldReportsBtn');
        const archiveMonthsInput = document.getElementById('archiveMonthsInput');
        const archiveResultMsg = document.getElementById('archiveResultMsg');
        archiveBtn?.addEventListener('click', async () => {
            const months = Number(archiveMonthsInput?.value);
            if (!Number.isFinite(months) || months <= 0) {
                showToast('يرجى إدخال عدد أشهر صحيح أكبر من صفر.', true);
                return;
            }
            if (!confirm(`سيتم نقل كل التقارير الأقدم من ${months} شهر (وكل بياناتها المرتبطة) إلى أوراق أرشيف منفصلة، ولن تظهر بعدها في سجل التعديلات أو التحليلات. هل تريد المتابعة؟`)) return;

            archiveBtn.disabled = true;
            archiveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الأرشفة...';
            archiveResultMsg.textContent = '';
            try {
                const res = await fetch(SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'archiveOldReports', payload: { role: currentUser.role, monthsToKeep: months } })
                });
                const result = await res.json();
                if (!result || result.status !== 'success') throw new Error(result?.message || 'فشلت عملية الأرشفة');

                if (result.archivedReports > 0) {
                    archiveResultMsg.className = 'small mt-2 text-success';
                    archiveResultMsg.textContent = `تمت أرشفة ${result.archivedReports} تقرير (الأقدم من ${result.cutoff}) بنجاح.`;
                    showToast(`تمت أرشفة ${result.archivedReports} تقرير بنجاح.`);
                    // تفريغ الكاش المحلي أيضاً حتى لا تظهر بيانات قديمة على هذا الجهاز.
                    localStorage.removeItem('reportsCache');
                    memoryReportsCache = null;
                    await refreshDashboard();
                } else {
                    archiveResultMsg.className = 'small mt-2 text-muted';
                    archiveResultMsg.textContent = result.message || 'لا توجد تقارير لأرشفتها بهذا التاريخ.';
                }
            } catch (e) {
                archiveResultMsg.className = 'small mt-2 text-danger';
                archiveResultMsg.textContent = e.message || 'حدث خطأ أثناء الأرشفة';
                showToast(e.message || 'حدث خطأ أثناء الأرشفة', true);
            } finally {
                archiveBtn.disabled = false;
                archiveBtn.innerHTML = '<i class="fa-solid fa-box-archive me-1"></i>أرشفة الآن';
            }
        });
    }

    await refreshDashboard();
}
