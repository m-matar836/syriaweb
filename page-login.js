// ===================================================================
//                      3. منطق صفحة تسجيل الدخول
// ===================================================================
async function handleLoginPage() {
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = e.target.username.value.trim().toLowerCase();
        const password = e.target.password.value.trim();
        const rememberMe = e.target.rememberMe.checked;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const errorMessage = document.getElementById('errorMessage');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جار التحقق...';
        errorMessage.textContent = '';
        try {
            const loginResult = await apiPost('doLogin', { username, password });
            if (loginResult.status !== 'success') throw new Error('Invalid credentials');

            // V67: حفظ جلسة الدخول — تُرفق تلقائياً بكل طلب لاحق.
            if (typeof storeAppToken === 'function') storeAppToken(loginResult.token);
            if (loginResult.csrfToken && typeof storeCsrfToken === 'function') storeCsrfToken(loginResult.csrfToken);
            
            if (rememberMe) {
                localStorage.setItem('currentUser', JSON.stringify(loginResult.user));
                localStorage.setItem('loginTimestamp', Date.now());
            } else {
                sessionStorage.setItem('currentUser', JSON.stringify(loginResult.user));
                sessionStorage.setItem('loginTimestamp', Date.now());
            }
            // «تذكرني» لا يكفي أن يختار التخزين: يجب أن تُعطَّل مهلة الخمول،
            // وإلا انتهت الجلسة بعد ٨ ساعات رغم بقاء البيانات على الجهاز.
            if (typeof setRememberedSession === 'function') setRememberedSession(rememberMe);

    // V70: نظّف كاشات المستخدم السابق من هذا المتصفح قبل قراءة أي
    // منها، وإلا رأى المستخدم الجديد تقارير أو دوام من جلسة غيره.
            if (typeof sweepForeignUserCaches === 'function') sweepForeignUserCaches();
            
            // V74: لا ننتظر بناء قاعدة البيانات الأساسية أثناء تسجيل الدخول.
            // التوثيق يبقى طلباً خفيفاً، والصفحة الهدف تستخدم الكاش المحلي فوراً
            // أو تجلب البيانات في مسارها الخاص. هذا يمنع Google Apps Script من
            // حجز استجابة الدخول على قراءة Products/Employees/Locations كاملة.
            // V74: doLogin no longer carries the potentially large initial-data payload.
            // getDbData() loads the user-scoped browser cache or fetches it after routing.
            errorMessage.textContent = 'تم التحقق بنجاح! جارٍ التحويل...';
            errorMessage.style.color = '#2ecc71';
            // V50: تسجيل الجلسة في دفتر الجلسات المحلي — مع إشعار عند الدخول من جهاز جديد.
            const isNewDevice = recordLoginSession(loginResult.user?.name || username);
            if (isNewDevice) {
                const notice = document.createElement('div');
                notice.className = 'alert alert-warning text-center small mt-2';
                notice.innerHTML = '<i class="fa-solid fa-shield-halved me-1"></i> تم تسجيل الدخول من جهاز جديد على هذا الحساب. إن لم تكن أنت، فغيّر كلمة المرور فوراً.';
                const card = document.querySelector('#view-login .login-form');
                if (card) {
                    const old = card.querySelector('.session-device-notice');
                    if (old) old.remove();
                    notice.classList.add('session-device-notice');
                    card.appendChild(notice);
                }
            }
            // V45/V46: حساب "user" ومنصبه "مروج" ينتقل للدوام، بقية الأدوار لشاشة التقارير.
            // المهلة كانت ثانية كاملة وهي زمن ميت صاف: لا شيء ينتظرها سوى
            // إظهار رسالة «تم التحقق بنجاح» قبل الانتقال. الآن الانتقال فوري،
            // فيختفي ثانية من زمن الإحساس بالدخول على كل مستخدم.
            // فحص إصدار الشيت منفصل ولا صلة له بهذا الانتقال.
            const homeRoute = isPromoterAccount(loginResult.user) ? 'attendance' : 'reports';
            navigateTo(homeRoute);
            // V69: إشعار المرفوضات يظهر عند فتح الحساب بعد الدخول (تقرير/دوام/حركة مادة مرفوضة).
            // V73: لكن ليس قبل بيانات الشاشة الأولى. الإشعاران معاً يطلبان 7 ردود
            // من Apps Script، وكانا يُطلقان هنا فيتزاحمان مع الطلبات التي ينتظرها
            // المستخدم فعلاً — أي أن الدخول كان يبدو بطيئاً بسبب إشعارات لا يراها
            // قبل ثانيتين على أي حال.
            const notifyAfterLogin = () => {
                if (typeof checkRejections === 'function') checkRejections({ force: true });
                if (typeof checkTeamEntryFeed === 'function') checkTeamEntryFeed();
            };
            if (typeof afterFirstScreen === 'function') {
                afterFirstScreen(() => {
                    if (typeof startDataVersionWatch === 'function') startDataVersionWatch();
                    if (typeof checkServerDataVersion === 'function') checkServerDataVersion();
                }, 1200);
                afterFirstScreen(notifyAfterLogin, 2000);
            } else {
                if (typeof startDataVersionWatch === 'function') startDataVersionWatch();
                if (typeof checkServerDataVersion === 'function') checkServerDataVersion();
                notifyAfterLogin();
            }
        } catch (error) {
            errorMessage.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة.';
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'دخـــول';
        }
    });

    const togglePassword = document.querySelector('.toggle-password');
    if(togglePassword) {
        togglePassword.addEventListener('click', function () {
            const passwordInput = document.getElementById('password');
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            this.classList.toggle('fa-eye');
            this.classList.toggle('fa-eye-slash');
        });
    }
}

// V58: تسجيل شاشة الدخول في موجه الـ SPA — تُنفَّذ handleLoginPage عند أول فتح.
if (typeof registerView === 'function') registerView('login', handleLoginPage);

