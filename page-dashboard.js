// ===================================================================
//   5.5 منطق صفحة التحليلات (dashboard.html) — رسوم بيانية وإحصائيات
// ===================================================================

async function handleDashboardPage() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    if (!currentUser) { if (typeof navigateTo === 'function') navigateTo('login'); else window.location.href = 'index.html'; return; }

    // V42: صلاحية صفحة التحليلات — admin و manager فقط (المدير يرى فريقه، الإداري الكل).
    // أي مستخدم آخر يُعاد إلى صفحة التقارير حتى لو فتح الرابط مباشرة.
    const role = String(currentUser.role || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'manager') {
        if (typeof navigateTo === 'function') navigateTo('reports');
        else window.location.href = 'reports.html';
        return;
    }

    let db = null;
    try { db = await getDbData(); } catch (e) { db = { locations: [], products: {}, employees: [] }; }

    // V73: Chart.js صارت تُجلب عند فتح هذه الشاشة (كانت تُنزَّل مع كل فتح
    // للتطبيق). الانتظار هنا شرط أن ترسم الرسوم فعلاً: كل مواضع `new Chart`
    // محروسة بـ`typeof Chart !== 'undefined'`، فلو رُسمت قبل وصولها لظهرت
    // التحليلات بلا رسوم بصمت. عند فشل الجلب تستمر الشاشة بلا رسوم.
    if (typeof ensureChartLib === 'function') { try { await ensureChartLib(); } catch (e) {} }

    const campaignFilter = document.getElementById('dashboardCampaignFilter');
    const rangeFilter = document.getElementById('dashboardRangeFilter');
    const periodSpan = document.getElementById('dashboardPeriodSpan');
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

    const verticalGradient = (ctx, chartArea, topColor, bottomColor) => {
        if (!chartArea || !ctx) return bottomColor;
        const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        g.addColorStop(0, topColor);
        g.addColorStop(1, bottomColor);
        return g;
    };

    const setDelta = (id, d) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!d || !Number.isFinite(d.pct)) { el.classList.add('d-none'); el.innerHTML = ''; return; }
        const up = d.pct >= 0;
        el.className = `kpi-delta ${up ? 'up' : 'down'}`;
        el.innerHTML = `${up ? '<i class="fa-solid fa-arrow-trend-up"></i>' : '<i class="fa-solid fa-arrow-trend-down"></i>'} ${Math.abs(d.pct)}%`;
    };
    const renderDeltas = (deltas) => {
        if (!deltas) return;
        setDelta('kpiTotalReportsDelta', deltas.reports);
        setDelta('kpiTotalSalesDelta', deltas.sales);
        setDelta('kpiActiveEmployeesDelta', deltas.employees);
    };
    const computePeriodDeltas = (reports, range) => {
        const n = range === 'all' ? 0 : (Number(range) || 30);
        if (!n) return null;
        const dayMs = 86400000;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const curStart = todayStart - (n - 1) * dayMs;
        const prevEnd = curStart - 1;
        const prevStart = prevEnd - (n - 1) * dayMs;
        let curReports = 0, prevReports = 0, curSales = 0, prevSales = 0;
        const curEmployees = new Set(), prevEmployees = new Set();
        (reports || []).forEach(r => {
            const iso = String(r.date || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
            const ts = new Date(iso + 'T12:00:00').getTime();
            const inCur = ts >= curStart && ts <= todayStart + dayMs - 1;
            const inPrev = ts >= prevStart && ts <= prevEnd;
            if (!inCur && !inPrev) return;
            let sales = 0;
            (r.sales || []).forEach(s => sales += (Number(s.price) || 0) * (Number(s.quantity) || 0));
            if (r.createdByName) { if (inCur) curEmployees.add(r.createdByName); if (inPrev) prevEmployees.add(r.createdByName); }
            if (inCur) { curReports++; curSales += sales; }
            if (inPrev) { prevReports++; prevSales += sales; }
        });
        const pct = (cur, prev) => prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0);
        return {
            reports: { pct: pct(curReports, prevReports) },
            sales: { pct: pct(curSales, prevSales) },
            employees: { pct: pct(curEmployees.size, prevEmployees.size) }
        };
    };

    // ===================================================================
    //  V50: خريطة لبنان الحرارية + تنبيهات ذكية + الموجز الأسبوعي
    // ===================================================================
    const dayMs50 = 86400000;
    const LEBANON_GOVS = [
        { key: 'عكار', x: 78, y: 20 },
        { key: 'الشمال', x: 66, y: 42 },
        { key: 'بعلبك الهرمل', x: 98, y: 92 },
        { key: 'جبل لبنان', x: 52, y: 128 },
        { key: 'بيروت', x: 40, y: 143 },
        { key: 'البقاع', x: 80, y: 143 },
        { key: 'النبطية', x: 40, y: 206 },
        { key: 'الجنوب', x: 28, y: 226 }
    ];

    const reportDateKey = (r) => String(r.date || '').slice(0, 10);
    const reportDateMs = (r) => { const k = reportDateKey(r); return /^\d{4}-\d{2}-\d{2}$/.test(k) ? new Date(k + 'T12:00:00').getTime() : 0; };
    const reportPointKey = (r) => [String(r.governorate || '').trim(), String(r.region || '').trim(), String(r.market || '').trim()].filter(Boolean).join(' | ');
    const reportSalesSum = (r) => (r.sales || []).reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.quantity) || 0), 0);
    const fmtShort = (v) => v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? Math.round(v / 1000) + 'K' : Math.round(v).toString();

    const windowReportsByRange = (reports, range) => {
        const days = range === 'all' ? null : (Number(range) || 30);
        if (!days) return reports || [];
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - (days - 1) * dayMs50;
        return (reports || []).filter(r => {
            const ms = reportDateMs(r);
            return ms && ms >= start;
        });
    };

    function renderLebanonMap(reports) {
        const wrap = document.getElementById('lebanonMapWrap');
        if (!wrap) return;
        const sums = new Map();
        (reports || []).forEach(r => {
            const g = String(r.governorate || '').trim();
            if (!g) return;
            const hit = LEBANON_GOVS.find(x => g.includes(x.key) || x.key.includes(g));
            if (!hit) return;
            sums.set(hit.key, (sums.get(hit.key) || 0) + reportSalesSum(r));
        });
        const max = Math.max(...[...sums.values(), 1]);
        const ramp = (t) => {
            t = Math.max(0, Math.min(1, t));
            const stops = [[224, 231, 255], [129, 140, 248], [79, 70, 229], [124, 58, 237]];
            const seg = t * (stops.length - 1);
            const i = Math.min(stops.length - 2, Math.floor(seg));
            const f = seg - i;
            const a = stops[i], b = stops[i + 1];
            return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
        };
        const dots = LEBANON_GOVS.map(v => {
            const value = sums.get(v.key) || 0;
            const t = value ? value / max : 0;
            const r = value ? (6 + 9 * Math.sqrt(t)).toFixed(1) : 4;
            let dy = (v.key === 'بيروت' || v.key === 'جبل لبنان') ? -18 : -13;
            if (v.y < 30) dy = -13; 
            const labelY = v.y + dy;
            return `<circle class="gov-dot" cx="${v.x}" cy="${v.y}" r="${r}" fill="${value ? ramp(t) : '#cbd5e1'}" opacity="${value ? .95 : .5}"><title>${v.key}: ${value ? fmtShort(value) + ' ليرة' : 'لا مبيعات في الفترة'}</title></circle>
            <text class="gov-label" x="${v.x}" y="${labelY}" text-anchor="middle">${v.key}</text>
            ${value ? `<text class="gov-value" x="${v.x}" y="${labelY + 14}" text-anchor="middle">${fmtShort(value)}</text>` : ''}`;
        }).join('');
        wrap.innerHTML = `<svg id="lebanonHeatmap" viewBox="0 0 150 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="خريطة لبنان الحرارية للمبيعات حسب المحافظة">
<path d="M82 10 C74 22 64 40 58 62 C53 80 48 100 44 122 C41 140 38 168 40 190 C41 208 38 224 36 238 C34 248 44 252 54 246 C64 240 66 226 72 212 C78 198 88 186 96 172 C104 158 112 146 118 132 C124 118 126 100 122 84 C118 68 110 52 100 38 C93 26 88 14 82 10 Z" fill="var(--primary-tint)" stroke="var(--primary)" stroke-opacity=".35" stroke-width="1.2"/>
${dots}
</svg>`;
    }

    function computeAnomalies(windowed, all, range) {
        const list = [];
        const windowKeys = new Set();
        windowed.forEach(r => { const k = reportPointKey(r); if (k) windowKeys.add(k); });
        const lastSeen = new Map();
        all.forEach(r => { const k = reportPointKey(r); if (k) lastSeen.set(k, Math.max(lastSeen.get(k) || 0, reportDateMs(r))); });
        lastSeen.forEach((ts, key) => {
            if (!windowKeys.has(key) && list.length < 3) {
                list.push({ tone: 'critical', icon: 'fa-triangle-exclamation', text: `النقطة «${key}» بدون أي تقرير في الفترة — راجعها قبل نهاية الحملة.` });
            }
        });
        const n = range === 'all' ? null : (Number(range) || 30);
        if (n) {
            const now = new Date();
            const curStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - (n - 1) * dayMs50;
            const prevEnd = curStart - 1;
            const prevStart = prevEnd - (n - 1) * dayMs50;
            const curMap = new Map(), prevMap = new Map();
            windowed.forEach(r => { const k = reportPointKey(r); if (k) curMap.set(k, (curMap.get(k) || 0) + reportSalesSum(r)); });
            all.forEach(r => {
                const ms = reportDateMs(r);
                if (ms >= prevStart && ms <= prevEnd) {
                    const k = reportPointKey(r);
                    if (k) prevMap.set(k, (prevMap.get(k) || 0) + reportSalesSum(r));
                }
            });
            curMap.forEach((v, key) => {
                const prev = prevMap.get(key) || 0;
                if (prev > 0 && v > 0 && v < prev * 0.5 && list.length < 6) {
                    list.push({ tone: 'warning', icon: 'fa-chart-line', text: `مبيعات «${key}» انخفضت ${Math.round((1 - v / prev) * 100)}% عن الفترة السابقة (${fmtShort(v)} مقابل ${fmtShort(prev)}).` });
                }
            });
        }
        const activeEmps = new Set(windowed.map(r => String(r.createdByName || '').trim()).filter(Boolean));
        const allEmps = new Set(all.map(r => String(r.createdByName || '').trim()).filter(Boolean));
        allEmps.forEach(e => { if (e && !activeEmps.has(e) && list.length < 6) list.push({ tone: 'warning', icon: 'fa-user-clock', text: `«${e}» لم يسجل أي تقرير في الفترة الحالية.` }); });
        const emptyCount = windowed.filter(r => !(r.sales || []).length).length;
        if (emptyCount >= 3 && list.length < 6) list.push({ tone: 'warning', icon: 'fa-file-circle-exclamation', text: `${emptyCount} تقرير مسجل بدون أي مبيعات — تأكد من صحة الإدخال.` });
        return list.slice(0, 6);
    }

    function renderAnomalies(windowed, all, range) {
        const box = document.getElementById('anomalyList');
        if (!box) return;
        const countBadge = document.getElementById('anomalyCount');
        const emptyBox = document.getElementById('anomalyEmpty');
        const list = computeAnomalies(windowed, all, range);
        if (countBadge) countBadge.textContent = list.length;
        if (list.length === 0) {
            box.innerHTML = '';
            emptyBox?.classList.remove('d-none');
            return;
        }
        emptyBox?.classList.add('d-none');
        box.innerHTML = list.map(a => `<li class="anomaly-item ${a.tone}"><span class="anomaly-icon"><i class="fa-solid ${a.icon}"></i></span><span>${escapeHtmlGlobal(a.text)}</span></li>`).join('');
    }

    const ARABIC_DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    function buildWeeklySummary(all) {
        const windowed = windowReportsByRange(all, 7);
        let totalSales = 0, totalQty = 0;
        const perPoint = new Map(), perEmployee = new Map(), campaigns = new Set();
        windowed.forEach(r => {
            const sum = reportSalesSum(r);
            totalSales += sum;
            (r.sales || []).forEach(s => { totalQty += Number(s.quantity) || 0; });
            if (r.campaign) campaigns.add(String(r.campaign));
            const pk = reportPointKey(r);
            if (pk) perPoint.set(pk, (perPoint.get(pk) || 0) + sum);
            const ename = String(r.createdByName || '').trim();
            if (ename) {
                const cur = perEmployee.get(ename) || { sales: 0, reports: 0 };
                cur.sales += sum; cur.reports++;
                perEmployee.set(ename, cur);
            }
        });
        const now = new Date();
        const daysLabels = [...windowed].sort((a, b) => reportDateMs(a) - reportDateMs(b)).map(reportDateKey);
        const bestPoint = [...perPoint.entries()].sort((a, b) => b[1] - a[1])[0];
        const topEmp = [...perEmployee.entries()].sort((a, b) => b[1].sales - a[1].sales)[0];
        const weak = [...perEmployee.entries()].sort((a, b) => a[1].sales - b[1].sales).find(e => perEmployee.get(e[0]).reports > 0);
        const lines = [];
        lines.push(`📊 الموجز الأسبوعي — ${daysLabels[0] || ''} إلى ${daysLabels[daysLabels.length - 1] || ''}`);
        lines.push('━━━━━━━━━━━━━━━━━━');
        lines.push(`• عدد التقارير: ${windowed.length}`);
        lines.push(`• إجمالي المبيعات: ${totalSales.toLocaleString('en-US')} ل.ل`);
        lines.push(`• إجمالي الكميات المباعة: ${totalQty.toLocaleString('en-US')}`);
        lines.push(`• الحملات المنفذة: ${campaigns.size ? [...campaigns].join('، ') : 'لا يوجد'}`);
        lines.push('');
        if (bestPoint) lines.push(`🏆 أفضل نقطة مبيعات: «${bestPoint[0]}» (${fmtShort(bestPoint[1])})`);
        if (topEmp) lines.push(`👤 أفضل مروج: «${topEmp[0]}» (${topEmp[1].reports} تقرير، ${fmtShort(topEmp[1].sales)})`);
        if (weak && weak[0] !== topEmp[0]) lines.push(`⚠️ أدنى أداء: «${weak[0]}» (${fmtShort(weak[1].sales)}) — يوصى بمراجعة`);
        lines.push('');
        lines.push('يُحضَّر الآلي الموجز من آخر 7 أيام. — لوحة التحكم الميدانية');
        return lines.join('\n');
    }

    function renderWeeklySummary(reports) {
        const output = document.getElementById('weeklySummaryOutput');
        if (!output) return;
        const text = buildWeeklySummary(reports);
        output.value = text;
        document.getElementById('copyWeeklyBtn')?.classList.remove('d-none');
        document.getElementById('downloadWeeklyBtn')?.classList.remove('d-none');
    }

    function renderIntelligence(allReports, range) {
        if (!allReports) return;
        const windowed = windowReportsByRange(allReports, range);
        renderLebanonMap(windowed);
        renderAnomalies(windowed, allReports, range);
    }

    // V61: إنجازات المروجين — عدد النقاط وقطع/قيمة مبيعات الفترة لكل مروج في جدول مرتّب.
    function renderPromoterStats(allReports, range) {
        const body = document.getElementById('promoterPerformanceBody');
        if (!body) return;
        const windowed = windowReportsByRange(allReports, range);
        const stats = new Map();
        windowed.forEach(r => {
            let promoters = Array.isArray(r.promoters) ? r.promoters.filter(Boolean).map(p => String(p).trim()) : [];
            if (!promoters.length && r.createdByName) promoters = [String(r.createdByName).trim()];
            if (!promoters.length) return;
            const qty = (r.sales || []).reduce((s, x) => s + (Number(x.quantity) || 0), 0);
            const value = (r.sales || []).reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.quantity) || 0), 0);
            promoters.forEach(n => {
                if (!n || n === 'غير محدد') return;
                const rec = stats.get(n) || { points: 0, qty: 0, value: 0 };
                rec.points++;
                rec.qty += qty;
                rec.value += value;
                stats.set(n, rec);
            });
        });
        const rows = [...stats.entries()].sort((a, b) => b[1].value - a[1].value || b[1].qty - a[1].qty || b[1].points - a[1].points);
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">لا توجد بيانات للمروجين في هذه الفترة.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(([name, s]) =>
            `<tr><td>${escapeHtmlGlobal(name)}</td><td>${s.points}</td><td>${s.qty}</td><td>${s.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>`
        ).join('');
    }

    // V63: إحصاءات المحلات والزيارات — آخر زيارة لكل محل وتحديد غير المزارة الشهر الحالي.
    function renderMarketStats(allReports) {
        const body = document.getElementById('marketStatsBody');
        if (!body) return;
        const reports = Array.isArray(allReports) ? allReports : [];
        const monthNow = new Date().toISOString().slice(0, 7);
        const byMarket = new Map();
        reports.forEach(r => {
            const name = String(r.market || '').trim();
            if (!name || name === 'غير محدد') return;
            if (!byMarket.has(name)) byMarket.set(name, []);
            byMarket.get(name).push(r);
        });
        const markets = [...byMarket.keys()].sort();
        const totalEl = document.getElementById('marketCountTotal');
        const visitedEl = document.getElementById('marketCountVisited');
        const remainingEl = document.getElementById('marketCountRemaining');
        let visited = 0;
        const rows = markets.map(name => {
            const list = byMarket.get(name);
            const dates = list.map(r => String(r.date || '')).filter(Boolean).sort().reverse();
            const last = dates[0] || '—';
            const visitedThisMonth = last.startsWith(monthNow);
            if (visitedThisMonth) visited++;
            const status = visitedThisMonth
                ? '<span class="badge bg-success">مزار هذا الشهر</span>'
                : '<span class="badge bg-warning text-dark">لم تزر هذا الشهر</span>';
            return `<tr><td>${escapeHtmlGlobal(name)}</td><td>${list.length}</td><td>${escapeHtmlGlobal(last)}</td><td>${status}</td></tr>`;
        }).join('');
        if (totalEl) totalEl.textContent = markets.length;
        if (visitedEl) visitedEl.textContent = visited;
        if (remainingEl) remainingEl.textContent = markets.length - visited;
        if (!rows) {
            body.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">لا توجد بيانات محلات لعرضها.</td></tr>';
            return;
        }
        body.innerHTML = rows;
    }

    const destroyCharts = () => {
        Object.values(charts).forEach(c => { try { c?.destroy(); } catch (e) {} });
        charts = {};
    }

    // V59: جلب التقارير عبر الكاش المشترك (cachedReportsFetch) — يعرض القديم فوراً
    // ويحدّث بالخلفية، فلا يُعاد تنزيل قاعدة التقارير كاملة مع كل فلتر أو تغيير سمة.
    function loadReports(force = false) {
        return cachedReportsFetch({
            userId: String(currentUser.id || ''),
            role: String(currentUser.role || ''),
            userName: String(currentUser.name || '')
        }, { ttlMinutes: 2, force });
    }

    // V59: جلب الإحصائيات المجمّعة من الخادم مع كاش محلي قصير (120 ثانية) —
    // تبديل الفلاتر أو السمة لا يتسبب بإعادة اتصال بالشبكة. fallback تلقائي للتجميع المحلي.
    let statsCache = null;
    let statsCacheTs = 0;
    async function loadDashboardStats(force = false) {
        if (!navigator.onLine) return null;
        if (!force && statsCache && (Date.now() - statsCacheTs) < 120000) return statsCache;
        try {
            const data = await apiGet('getDashboardData', {
                userId: String(currentUser.id || ''),
                role: String(currentUser.role || '')
            });
            if (data && data.status === 'success' && data.kpis) {
                statsCache = data;
                statsCacheTs = Date.now();
                return data;
            }
            return null;
        } catch (e) {
            console.warn('تعذر جلب بيانات التحليلات المجمعة، سيتم التجميع محلياً:', e);
            return null;
        }
    }

    // V59: عرض موحّد — مسار الخادم أو التجميع المحلي + التنبيهات/الخريطة من نفس القائمة.
    function renderAllView(stats, allReports, campaign, range) {
        const reports = Array.isArray(allReports) ? allReports : [];
        if (stats && !campaign) {
            renderFromServerStats(stats, reports);
        } else {
            const filtered = campaign ? reports.filter(r => String(r.campaign || '') === campaign) : reports;
            renderClientSide(filtered, db, range);
        }
        renderIntelligence(reports, range);
        renderPromoterStats(reports, range);
        renderMarketStats(reports);
    }

    let lastView = null;
    async function refreshDashboard(opts = {}) {
        destroyCharts();
        const campaign = campaignFilter?.value || '';
        const range = rangeFilter?.value || '30';
        let stats, allReports;
        if (opts.cached && lastView) {
            // إعادة رسم فورية من بيانات الذاكرة (مثل تبديل السمة) دون أي شبكة.
            stats = lastView.stats;
            allReports = lastView.allReports;
        } else {
            if (opts.force) statsCache = null;
            // جلب متوازٍ: الإحصائيات + التقارير دفعة واحدة بدل سلسلة متتالية متكرّرة.
            [stats, allReports] = await Promise.all([loadDashboardStats(opts.force), loadReports(opts.force)]);
            lastView = { stats, allReports, campaign, range };
        }
        renderAllView(stats, allReports, campaign, range);
    }

    function renderFromServerStats(stats, deltasReports) {
        const kpis = stats.kpis || {};
        const kpiReports = document.getElementById('kpiTotalReports');
        const kpiSales = document.getElementById('kpiTotalSales');
        const kpiEmployees = document.getElementById('kpiActiveEmployees');
        const kpiProducts = document.getElementById('kpiTotalProducts');
        if (kpiReports) kpiReports.textContent = kpis.totalReports || 0;
        if (kpiSales) kpiSales.textContent = (kpis.totalSales || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (kpiEmployees) kpiEmployees.textContent = kpis.activeEmployees || 0;
        if (kpiProducts) kpiProducts.textContent = Object.values(db.products || {}).flat().length || 0;

        const range = rangeFilter?.value || '30';
        if (periodSpan) periodSpan.textContent = range === 'all' ? 'كل الفترات' : `${range} يوم`;
        if (Array.isArray(deltasReports)) renderDeltas(computePeriodDeltas(deltasReports, range));

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
                        borderColor: '#6366f1',
                        backgroundColor: (c) => verticalGradient(c.chart.ctx, c.chart.chartArea, 'rgba(99,102,241,.3)', 'rgba(99,102,241,.02)'),
                        fill: true,
                        tension: .42,
                        borderWidth: 2.5,
                        pointRadius: 3,
                        pointHoverRadius: 7,
                        pointBackgroundColor: '#fff',
                        pointBorderColor: '#6366f1',
                        pointBorderWidth: 2
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
                        backgroundColor: ['#6366f1','#22d3ee','#34d399','#f59e0b','#f43f5e','#a78bfa','#f1c40f'],
                        borderWidth: 1
                    }]
                },
                options: pieChartOptions(textColor())
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
                        backgroundColor: (c) => verticalGradient(c.chart.ctx, c.chart.chartArea, 'rgba(16,185,129,.6)', 'rgba(16,185,129,.05)'),
                        borderColor: '#10b981',
                        borderWidth: 1,
                        borderRadius: 6,
                        maxBarThickness: 34
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

    function renderClientSide(reports, db, range) {
        const txt = () => getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#333';
        const grd = () => getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || '#dfe7f1';
        const filtered = reports || [];

        if (periodSpan) periodSpan.textContent = range && range !== 'all' ? `${range} يوم` : 'كل الفترات';
        if (range && range !== 'all') renderDeltas(computePeriodDeltas(filtered, range));

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
        const rangeDays = range && range !== 'all' ? Math.min(Math.max(Math.round(Number(range)) || 30, 1), 90) : 90;
        for (let i = rangeDays - 1; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); dailyMap.set(d.toISOString().slice(0,10), 0); }
        filtered.forEach(r => { const key = String(r.date || '').slice(0,10); if (dailyMap.has(key)) { let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); dailyMap.set(key,(dailyMap.get(key)||0)+sum); } });

        const dailyCtx = document.getElementById('chartDailySales');
        if (dailyCtx && typeof Chart !== 'undefined') {
            charts.daily = new Chart(dailyCtx.getContext('2d'), {
                type: 'line',
                data: { labels: [...dailyMap.keys()].map(k=>k.slice(5)), datasets: [{ label:'المبيعات (بالمليون)', data:[...dailyMap.values()].map(v=>v/1000000), borderColor:'#6366f1', backgroundColor:(c)=>verticalGradient(c.chart.ctx, c.chart.chartArea, 'rgba(99,102,241,.3)', 'rgba(99,102,241,.02)'), fill:true, tension:.42, borderWidth:2.5, pointRadius:3, pointHoverRadius:7, pointBackgroundColor:'#fff', pointBorderColor:'#6366f1', pointBorderWidth:2 }] },
                options: baseChartOptions('إجمالي المبيعات اليومية بالل.ل', txt(), grd())
            });
        }

        const campMap = new Map();
        filtered.forEach(r => { const c=String(r.campaign||'غير محدد'); let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); campMap.set(c,(campMap.get(c)||0)+sum); });
        const pieCtx = document.getElementById('chartCampaignPie');
        if (pieCtx && typeof Chart !== 'undefined') {
            const d=[...campMap.entries()];
            charts.pie = new Chart(pieCtx.getContext('2d'), { type:'doughnut', data:{ labels:d.map(([k])=>k), datasets:[{ data:d.map(([,v])=>v), backgroundColor:['#6366f1','#22d3ee','#34d399','#f59e0b','#f43f5e','#a78bfa','#f1c40f'], borderWidth:1, hoverOffset:6 }] }, options: pieChartOptions(txt()) });
        }

        const govMap = new Map();
        filtered.forEach(r => { const g=String(r.governorate||'غير محدد'); let sum=0; (r.sales||[]).forEach(s=>sum+=(Number(s.price)||0)*(Number(s.quantity)||0)); govMap.set(g,(govMap.get(g)||0)+sum); });
        const govCtx = document.getElementById('chartGovernorateBar');
        if (govCtx && typeof Chart !== 'undefined') {
            const d=[...govMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
            charts.gov = new Chart(govCtx.getContext('2d'), { type:'bar', data:{ labels:d.map(([k])=>k), datasets:[{ label:'المبيعات', data:d.map(([,v])=>Math.round(v/1000000*100)/100), backgroundColor:(c)=>verticalGradient(c.chart.ctx, c.chart.chartArea, 'rgba(16,185,129,.6)', 'rgba(16,185,129,.05)'), borderColor:'#10b981', borderWidth:1, borderRadius:6, maxBarThickness:34 }] }, options: baseChartOptions('المبيعات بالمليون الليرة', txt(), grd()) });
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
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 700, easing: 'easeOutQuart' },
            plugins: {
                legend: {
                    labels: {
                        color: textColor,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: 8,
                        padding: 16,
                        font: { family: 'inherit', size: 11, weight: 600 }
                    }
                },
                title: {
                    display: !!title,
                    text: title,
                    color: textColor,
                    font: { family: 'inherit', size: 13, weight: 700 },
                    padding: { bottom: 8 }
                },
                tooltip: {
                    rtl: true,
                    backgroundColor: 'rgba(13, 19, 38, .92)',
                    titleColor: '#e7ecf7',
                    bodyColor: '#c3cde0',
                    borderColor: 'rgba(127, 134, 255, .25)',
                    borderWidth: 1,
                    cornerRadius: 12,
                    padding: 12,
                    boxPadding: 6,
                    usePointStyle: true,
                    titleFont: { family: 'inherit', weight: 700 },
                    bodyFont: { family: 'inherit' }
                }
            },
            scales: {
                x: {
                    ticks: { color: textColor, maxTicksLimit: 10, font: { family: 'inherit' } },
                    grid: { color: gridColor }
                },
                y: {
                    ticks: { color: textColor, font: { family: 'inherit' } },
                    grid: { color: gridColor }
                }
            }
        };
    }

    function pieChartOptions(labelsColor) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 700, easing: 'easeOutQuart' },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: labelsColor,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: 8,
                        padding: 14,
                        font: { family: 'inherit', size: 11 }
                    }
                },
                tooltip: {
                    rtl: true,
                    backgroundColor: 'rgba(13, 19, 38, .92)',
                    titleColor: '#e7ecf7',
                    bodyColor: '#c3cde0',
                    borderColor: 'rgba(127, 134, 255, .25)',
                    borderWidth: 1,
                    cornerRadius: 12,
                    padding: 12,
                    usePointStyle: true,
                    bodyFont: { family: 'inherit' }
                }
            }
        };
    }

    // Re-render charts on theme change for correct colors — من الذاكرة دون أي شبكة.
    const themeObserver = new MutationObserver(() => refreshDashboard({ cached: true }));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    campaignFilter?.addEventListener('change', refreshDashboard);
    rangeFilter?.addEventListener('change', refreshDashboard);

    // V63: أهداف المروجين الشهرية — تُحفظ على الخادم في ورقة PromoterGoals.
    const goalsMonthInput = document.getElementById('promoterGoalsMonthInput');
    const savePromoterGoalsBtn = document.getElementById('savePromoterGoalsBtn');
    const promoterGoalsMap = new Map();
    const goalsMonth = () => goalsMonthInput?.value || new Date().toISOString().slice(0, 7);
    async function loadPromoterGoals(month) {
        if (!navigator.onLine) return;
        try {
            const data = await apiGet('getPromoterGoals', { month });
            if (data && data.status === 'success' && Array.isArray(data.goals)) {
                const m = new Map();
                data.goals.forEach(g => m.set(String(g.promoter || ''), { points: Number(g.points) || 0, pieces: Number(g.pieces) || 0 }));
                promoterGoalsMap.set(month, m);
            }
        } catch (e) { /* يحتفظ بفراغ إن لم تتوفر الشبكة */ }
    }
    function renderPromoterGoals(allReports, month) {
        const body = document.getElementById('promoterGoalsBody');
        const monthEl = document.getElementById('promoterGoalsMonth');
        if (!body) return;
        if (monthEl) monthEl.textContent = month;
        const goals = promoterGoalsMap.get(month) || new Map();
        const stats = new Map();
        (allReports || []).forEach(r => {
            const d = String(r.date || '');
            if (!d.startsWith(String(month || ''))) return;
            let promoters = Array.isArray(r.promoters) ? r.promoters.filter(Boolean).map(p => String(p).trim()) : [];
            if (!promoters.length && r.createdByName) promoters = [String(r.createdByName).trim()];
            if (!promoters.length) return;
            const qty = (r.sales || []).reduce((s, x) => s + (Number(x.quantity) || 0), 0);
            promoters.forEach(n => {
                if (!n || n === 'غير محدد') return;
                const rec = stats.get(n) || { points: 0, qty: 0 };
                rec.points++;
                rec.qty += qty;
                stats.set(n, rec);
            });
        });
        const names = [...new Set([...goals.keys(), ...stats.keys()])];
        if (!names.length) {
            body.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">لا توجد بيانات أو أهداف لهذا الشهر.</td></tr>';
            return;
        }
        const pct = (actual, goal) => (goal && goal > 0) ? Math.min(100, Math.round(actual / goal * 100)) : null;
        const bar = (p) => p === null
            ? '<span class="text-muted">—</span>'
            : `<div class="d-flex align-items-center gap-2"><div class="progress flex-grow-1" style="height:8px;"><div class="progress-bar ${p >= 100 ? 'bg-success' : 'bg-primary'}" style="width:${p}%"></div></div><small>${p}%</small></div>`;
        body.innerHTML = names.sort().map(n => {
            const a = stats.get(n) || { points: 0, qty: 0 };
            const g = goals.get(n) || {};
            return `<tr><td>${escapeHtmlGlobal(n)}</td>` +
                `<td><input type="number" min="0" class="form-control form-control-sm goal-input" data-promoter="${escapeHtmlGlobal(n)}" data-goal="points" value="${g.points ?? ''}" placeholder="—"></td>` +
                `<td>${a.points}</td><td>${bar(pct(a.points, g.points))}</td>` +
                `<td><input type="number" min="0" class="form-control form-control-sm goal-input" data-promoter="${escapeHtmlGlobal(n)}" data-goal="pieces" value="${g.pieces ?? ''}" placeholder="—"></td>` +
                `<td>${a.qty}</td><td>${bar(pct(a.qty, g.pieces))}</td></tr>`;
        }).join('');
    }
    async function refreshGoals() {
        const month = goalsMonth();
        if (!goalsMonthInput) return;
        if (!promoterGoalsMap.has(month)) await loadPromoterGoals(month);
        renderPromoterGoals((lastView && lastView.allReports) || [], month);
    }
    if (goalsMonthInput) {
        goalsMonthInput.value = new Date().toISOString().slice(0, 7);
        goalsMonthInput.addEventListener('change', async () => {
            const m = goalsMonth();
            if (!promoterGoalsMap.has(m)) await loadPromoterGoals(m);
            renderPromoterGoals((lastView && lastView.allReports) || [], m);
        });
    }
    savePromoterGoalsBtn?.addEventListener('click', async () => {
        const month = goalsMonth();
        const entries = new Map();
        document.querySelectorAll('#promoterGoalsBody .goal-input').forEach(inp => {
            const name = inp.dataset.promoter;
            if (!name) return;
            if (!entries.has(name)) entries.set(name, { points: 0, pieces: 0 });
            if (inp.dataset.goal === 'points') entries.get(name).points = Number(inp.value) || 0;
            else entries.get(name).pieces = Number(inp.value) || 0;
        });
        const flat = [...entries.entries()].map(([promoter, v]) => ({ promoter, points: v.points, pieces: v.pieces })).filter(e => e.points > 0 || e.pieces > 0);
        savePromoterGoalsBtn.disabled = true;
        savePromoterGoalsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ الحفظ...';
        try {
            const result = await apiPost('savePromoterGoals', { role: currentUser.role, month, entries: flat });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل الحفظ');
            promoterGoalsMap.set(month, new Map(flat.map(e => [e.promoter, { points: e.points, pieces: e.pieces }])));
            renderPromoterGoals((lastView && lastView.allReports) || [], month);
            showToast('تم حفظ أهداف الشهر.');
        } catch (e) {
            showToast('تعذر حفظ الأهداف: ' + (e.message || e), true);
        } finally {
            savePromoterGoalsBtn.disabled = false;
            savePromoterGoalsBtn.innerHTML = '<i class="fa-solid fa-floppy-disk me-1"></i>حفظ الأهداف';
        }
    });

    // V63: النسخ الاحتياطي الأسبوعي — للإداري فقط.
    const backupCardWrap = document.getElementById('backupCardWrap');
    if (role === 'admin' && backupCardWrap) {
        backupCardWrap.classList.remove('d-none');
        const backupResultMsg = document.getElementById('backupResultMsg');
        const doBackupAction = async (action, btn, originalHTML, failText) => {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ التنفيذ...';
            backupResultMsg.className = 'small mt-2';
            backupResultMsg.textContent = '';
            try {
                const result = await apiPost(action, { role: currentUser.role });
                if (!result || result.status !== 'success') throw new Error(result?.message || 'فشلت العملية');
                backupResultMsg.className = 'small mt-2 text-success';
                backupResultMsg.innerHTML = result.url
                    ? `<i class="fa-solid fa-circle-check me-1"></i>تم إنشاء النسخة: <a href="${result.url}" target="_blank" rel="noopener">افتح النسخة الاحتياطية</a>`
                    : `<i class="fa-solid fa-circle-check me-1"></i>${escapeHtmlGlobal(result.message || 'تمت العملية بنجاح.')}`;
                showToast(result.message || 'تمت العملية بنجاح.');
            } catch (e) {
                backupResultMsg.className = 'small mt-2 text-danger';
                backupResultMsg.textContent = e.message || failText;
                showToast(e.message || failText, true);
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHTML;
            }
        };
        const setupBtn = document.getElementById('setupWeeklyBackupBtn');
        const backupNowBtn = document.getElementById('backupNowBtn');
        setupBtn?.addEventListener('click', () => doBackupAction('setupWeeklyBackup', setupBtn, '<i class="fa-solid fa-clock me-1"></i>تفعيل النسخ الأسبوعي', 'تعذر تفعيل النسخ الاحتياطي الأسبوعي.'));
        backupNowBtn?.addEventListener('click', () => doBackupAction('backupNow', backupNowBtn, '<i class="fa-solid fa-rotate me-1"></i>نسخ احتياطي الآن', 'تعذر إنشاء النسخة الاحتياطية.'));
    }

    // V50: الموجز الأسبوعي — إنشاء + نسخ + تنزيل.
    const generateWeeklyBtn = document.getElementById('generateWeeklyBtn');
    const copyWeeklyBtn = document.getElementById('copyWeeklyBtn');
    const downloadWeeklyBtn = document.getElementById('downloadWeeklyBtn');
    generateWeeklyBtn?.addEventListener('click', async () => {
        generateWeeklyBtn.disabled = true;
        generateWeeklyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ التحليل...';
        try {
            const reports = await loadReports();
            renderWeeklySummary(reports);
            showToast('تم إنشاء الموجز الأسبوعي.');
            copyWeeklyBtn?.classList.remove('d-none');
            downloadWeeklyBtn?.classList.remove('d-none');
        } catch (e) {
            showToast('تعذر إنشاء الموجز: ' + (e.message || e), true);
        } finally {
            generateWeeklyBtn.disabled = false;
            generateWeeklyBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles me-1"></i>إنشاء الموجز';
        }
    });
    copyWeeklyBtn?.addEventListener('click', () => {
        const output = document.getElementById('weeklySummaryOutput');
        if (!output || !output.value) return;
        navigator.clipboard?.writeText(output.value).then(() => showToast('تم نسخ الموجز.'), () => showToast('تعذر النسخ.', true));
    });
    downloadWeeklyBtn?.addEventListener('click', () => {
        const output = document.getElementById('weeklySummaryOutput');
        if (!output || !output.value) return;
        downloadTextFile(`weekly_summary_${new Date().toISOString().slice(0, 10)}.txt`, output.value, 'text/plain');
    });

    const exportBtn = document.getElementById('exportDashboardCSV');
    exportBtn?.addEventListener('click', async () => {
        const reports = await loadReports();
        const campaign = campaignFilter?.value || '';
        const filtered = campaign ? reports.filter(r => String(r.campaign || '') === campaign) : reports;
        const csv = reportsToCSV(filtered);
        downloadTextFile(`reports_${campaign || 'all'}_${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv');
        showToast('تم تصدير CSV بنجاح.');
    });

    // V61: تصدير Excel للوحة التحليلات — تحميل xlsx من CDN عند الطلب.
    const exportXlsxBtn = document.getElementById('exportDashboardXLSX');
    exportXlsxBtn?.addEventListener('click', async () => {
        if (!navigator.onLine) { showToast('تصدير Excel يتطلب اتصالاً بالإنترنت، استخدم CSV.', true); return; }
        exportXlsxBtn.disabled = true;
        exportXlsxBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ التحضير...';
        try {
            const XLSX = await loadXlsxLibrary();
            if (!XLSX) { showToast('تعذر تحميل مكتبة Excel.', true); return; }
            const reports = await loadReports();
            const campaign = campaignFilter?.value || '';
            const filtered = campaign ? reports.filter(r => String(r.campaign || '') === campaign) : reports;
            if (!filtered.length) { showToast('لا توجد بيانات للتصدير.', true); return; }
            // أعمدة موازية لتصدير CSV — القيم كنص مع توجيه الخلايا نحو اليمين.
            const headers = ['رقم التقرير','التاريخ','الحملة','الحدث','المحافظة','المنطقة','المحل','المشرف','المنسق','تبعية الجرد','عدد الأيام','الوقت من','الوقت إلى','هاتف','المبيعات','الكمية','عدد المبيعات','المصاريف','عدد المصاريف','ملاحظات','أنشئ بواسطة','تاريخ الإنشاء'];
            const aoa = [headers];
            filtered.forEach(r => {
                let salesTotal = 0, salesQty = 0, salesCount = 0;
                (r.sales || []).forEach(s => {
                    salesTotal += (Number(s.price) || 0) * (Number(s.quantity) || 0);
                    salesQty += Number(s.quantity) || 0;
                    salesCount++;
                });
                let expenseTotal = 0, expenseCount = 0;
                (r.expenses || []).forEach(e => { expenseTotal += Number(e.quantity) || 0; expenseCount++; });
                aoa.push([
                    String(r.id ?? ''), r.date, r.campaign, r.event, r.governorate, r.region, r.market,
                    r.supervisor, r.coordinator, r.inventoryDependency, r.eventDays, r.timeFrom, r.timeTo,
                    r.phoneNumber, salesTotal, salesQty, salesCount, expenseTotal, expenseCount,
                    r.notes, r.createdByName, r.createdAt
                ].map(v => String(v ?? '')));
            });
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            ws['!cols'] = headers.map((h, i) => ({ wch: h === 'رقم التقرير' ? 14 : h === 'ملاحظات' ? 30 : i ? 16 : 14 }));
            if (!ws['!dir']) ws['!dir'] = 'rtl';
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'تقارير');
            XLSX.writeFile(wb, `reports_${campaign || 'all'}_${new Date().toISOString().slice(0,10)}.xlsx`);
            showToast('تم تصدير Excel بنجاح.');
        } catch (e) {
            showToast('تعذر تصدير Excel: ' + (e.message || e), true);
        } finally {
            exportXlsxBtn.disabled = false;
            exportXlsxBtn.innerHTML = '<i class="fa-solid fa-file-excel me-1"></i>تصدير Excel';
        }
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
                const result = await apiPost('archiveOldReports', { role: currentUser.role, monthsToKeep: months });
                if (!result || result.status !== 'success') throw new Error(result?.message || 'فشلت عملية الأرشفة');

                if (result.archivedReports > 0) {
                    archiveResultMsg.className = 'small mt-2 text-success';
                    archiveResultMsg.textContent = `تمت أرشفة ${result.archivedReports} تقرير (الأقدم من ${result.cutoff}) بنجاح.`;
                    showToast(`تمت أرشفة ${result.archivedReports} تقرير بنجاح.`);
                    // تفريغ الكاش المحلي أيضاً حتى لا تظهر بيانات قديمة على هذا الجهاز.
                    invalidateReportsCache();
                    await refreshDashboard({ force: true });
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

        // V69.1: أرشفة سجلات الدوام القديمة (خيار منفصل).
        const attendanceArchiveBtn = document.getElementById('archiveOldAttendanceBtn');
        const attendanceArchiveMonthsInput = document.getElementById('archiveAttendanceMonthsInput');
        const attendanceArchiveResultMsg = document.getElementById('archiveAttendanceResultMsg');
        attendanceArchiveBtn?.addEventListener('click', async () => {
            const months = Number(attendanceArchiveMonthsInput?.value);
            if (!Number.isFinite(months) || months <= 0) {
                showToast('يرجى إدخال عدد أشهر صحيح أكبر من صفر.', true);
                return;
            }
            if (!confirm(`سيتم نقل سجلات الدوام الأقدم من ${months} شهر إلى ورقة أرشيف منفصلة (attendance_Archive)، ولن تظهر بعدها في قائمة الحضور. هل تريد المتابعة؟`)) return;

            attendanceArchiveBtn.disabled = true;
            attendanceArchiveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> جارٍ الأرشفة...';
            attendanceArchiveResultMsg.textContent = '';
            try {
                const result = await apiPost('archiveOldAttendance', { role: currentUser.role, monthsToKeep: months });
                if (!result || result.status !== 'success') throw new Error(result?.message || 'فشلت عملية الأرشفة');

                if (result.archivedAttendance > 0) {
                    attendanceArchiveResultMsg.className = 'small mt-2 text-success';
                    attendanceArchiveResultMsg.textContent = `تمت أرشفة ${result.archivedAttendance} سجل دوام (الأقدم من ${result.cutoff}) بنجاح.`;
                    showToast(`تمت أرشفة ${result.archivedAttendance} سجل دوام بنجاح.`);
                    localStorage.removeItem('attendanceCache');
                    window.dispatchEvent(new CustomEvent('attendanceCacheInvalidated'));
                } else {
                    attendanceArchiveResultMsg.className = 'small mt-2 text-muted';
                    attendanceArchiveResultMsg.textContent = result.message || 'لا توجد سجلات دوام لأرشفتها بهذا التاريخ.';
                }
            } catch (e) {
                attendanceArchiveResultMsg.className = 'small mt-2 text-danger';
                attendanceArchiveResultMsg.textContent = e.message || 'حدث خطأ أثناء الأرشفة';
                showToast(e.message || 'حدث خطأ أثناء الأرشفة', true);
            } finally {
                attendanceArchiveBtn.disabled = false;
                attendanceArchiveBtn.innerHTML = '<i class="fa-solid fa-clock-rotate-left me-1"></i>أرشفة الدوام';
            }
        });
    }

    // V58: عند إعادة زيارة شاشة التحليلات من قائمة التنقل نُحدّث البيانات من الخادم
    // (وعند غياب الاتصال نرجع للكاش المعروض) — لأن بيانات التقارير قد تكون تغيّرت.
    window.addEventListener('spaViewRevisited', async (event) => {
        if (event.detail && event.detail.route !== 'dashboard') return;
        await refreshDashboard({ force: true });
    });

    // بعد زر «تحديث البيانات»: إعادة تحميل التحليلات من الخادم القيم.
    window.addEventListener('appDataRefreshed', () => { refreshDashboard({ force: true }); });

    await refreshDashboard();
    await refreshGoals();

    // 3D tilt على بطاقات KPI (يُفعّل فقط على أجهزة الماوس؛ يُستثنى اللمس).
    if (window.matchMedia('(hover: hover)').matches && window.matchMedia('(pointer: fine)').matches) {
        document.querySelectorAll('.kpi-card').forEach(card => {
            card.addEventListener('mousemove', (event) => {
                const rect = card.getBoundingClientRect();
                const rx = ((event.clientY - rect.top) / rect.height - 0.5) * -12;
                const ry = ((event.clientX - rect.left) / rect.width - 0.5) * 16;
                card.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-4px)`;
            });
            card.addEventListener('mouseleave', () => { card.style.transform = ''; });
        });
    }
}

// V58: تسجيل شاشة التحليلات في موجه الـ SPA.
if (typeof registerView === 'function') registerView('dashboard', handleDashboardPage);
