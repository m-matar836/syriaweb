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
            const resLogin = await fetch(SCRIPT_URL, {
                method: 'POST', body: JSON.stringify({ action: 'doLogin', payload: { username, password } }),
            });
            const loginResult = await resLogin.json();
            if (loginResult.status !== 'success') throw new Error('Invalid credentials');
            
            if (rememberMe) {
                localStorage.setItem('currentUser', JSON.stringify(loginResult.user));
                localStorage.setItem('loginTimestamp', Date.now());
            } else {
                sessionStorage.setItem('currentUser', JSON.stringify(loginResult.user));
                sessionStorage.setItem('loginTimestamp', Date.now());
            }
            
            await getDbData();
            errorMessage.textContent = 'تم التحقق بنجاح! جارٍ التحويل...';
            errorMessage.style.color = '#2ecc71';
            // V45: حساب "user" ينتقل مباشرة لصفحة الدوام (الصفحة الوحيدة المتاحة له).
            // V46: التوجيه لصفحة الدوام فقط يقتصر على حساب role="user" ومنصبه "مروج".
            const loggedInRole = String(loginResult.user?.role || '').trim().toLowerCase();
            const loggedInJobPosition = String(loginResult.user?.jobPosition || '').trim();
            const destination = (loggedInRole === 'user' && loggedInJobPosition === 'مروج') ? 'attendance.html' : 'reports.html';
            setTimeout(() => { window.location.href = destination; }, 1000);
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

