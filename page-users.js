// ===================================================================
//                   صفحة إدارة المستخدمين والصلاحيات (V68)
//  تكون متاحة للإداري (admin) فقط — يحميها أيضاً الموجّه في core.js.
// ===================================================================
const ROLES_LABELS = {
    admin: 'إداري',
    manager: 'مدير',
    auditor: 'مدقق',
    user: 'مستخدم'
};

async function handleUsersPage() {
    const view = document.getElementById('view-users');
    if (!view) return;

    const tbody = document.getElementById('usersTableBody');
    const searchInput = document.getElementById('usersSearchInput');
    const statusMsg = document.getElementById('usersStatusMsg');
    const addUserBtn = document.getElementById('addUserBtn');
    const form = document.getElementById('userForm');
    const userModalEl = document.getElementById('userModal');
    const userModal = userModalEl ? new bootstrap.Modal(userModalEl) : null;

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const showStatus = (msg, isError) => {
        if (!statusMsg) return;
        statusMsg.textContent = msg;
        statusMsg.className = 'small mt-2 ' + (isError ? 'text-danger' : 'text-success');
    };

    const currentUser = () => {
        try { return JSON.parse(localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'null'); }
        catch (e) { return null; }
    };

    let users = [];

    async function loadUsers() {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin me-1"></i> جاري التحميل...</td></tr>`;
        try {
            const result = await apiGet('getUsersAdmin', {});
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر تحميل المستخدمين');
            users = Array.isArray(result.users) ? result.users : [];
            renderUsers();
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">تعذر تحميل المستخدمين: ${esc(e.message || e)}</td></tr>`;
        }
    }

    function renderUsers() {
        const q = String(searchInput?.value || '').trim().toLowerCase();
        const filtered = users.filter(u => !q || String(u.name || '').toLowerCase().includes(q) || String(u.username || '').toLowerCase().includes(q));
        if (!filtered.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">لا توجد نتائج</td></tr>`;
            return;
        }
        const me = currentUser();
        tbody.innerHTML = filtered.map((u, i) => {
            const isSelf = me && String(u.id) === String(me.id);
            const delBtn = isSelf
                ? '<span class="text-muted small" title="لا يمكنك حذف حسابك">أنت</span>'
                : `<button class="btn btn-sm btn-outline-danger delete-user-btn" data-id="${esc(u.id)}" data-username="${esc(u.username)}" title="حذف المستخدم"><i class="fa-solid fa-trash"></i></button>`;
            return `<tr>
                <td>${i + 1}</td>
                <td>${esc(u.name)}</td>
                <td dir="ltr">${esc(u.username)}</td>
                <td><span class="badge ${u.systemRole === 'admin' ? 'bg-danger' : (u.systemRole === 'manager' ? 'bg-primary' : (u.systemRole === 'auditor' ? 'bg-warning text-dark' : 'bg-secondary'))}">${esc(ROLES_LABELS[u.systemRole] || u.systemRole || '?')}</span></td>
                <td>${esc(u.role || u.jobPosition || '-')}</td>
                <td>${esc(u.mgr || '-')}</td>
                <td class="text-nowrap">
                    <button class="btn btn-sm btn-outline-primary edit-user-btn" data-id="${esc(u.id)}" title="تعديل المستخدم"><i class="fa-solid fa-pen"></i></button> ${delBtn}
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('.edit-user-btn').forEach(btn => btn.addEventListener('click', () => openUserModal(btn.dataset.id)));
        tbody.querySelectorAll('.delete-user-btn').forEach(btn => btn.addEventListener('click', () => deleteUserHandler(btn.dataset.id, btn.dataset.username)));
    }

    function openUserModal(id) {
        showStatus('');
        document.getElementById('userModalLabel').textContent = 'تعديل مستخدم';
        document.getElementById('userFormId').value = '';
        document.getElementById('userNameInput').value = '';
        document.getElementById('userUsernameInput').value = '';
        document.getElementById('userUsernameInput').readOnly = false;
        document.getElementById('userPasswordInput').value = '';
        document.getElementById('userPasswordHint').textContent = 'كلمة مرور جديدة (٤ أحرف على الأقل). تُترك فارغة للإبقاء على الحالية.';
        document.getElementById('userRoleInput').value = 'user';
        document.getElementById('userJobInput').value = '';
        document.getElementById('userManagerInput').value = '';

        if (id) {
            const u = users.find(x => String(x.id) === String(id));
            if (!u) { showStatus('المستخدم غير موجود في القائمة المحلية، حاول التحديث.', true); return; }
            document.getElementById('userFormId').value = u.id;
            document.getElementById('userNameInput').value = u.name || '';
            document.getElementById('userUsernameInput').value = u.username || '';
            document.getElementById('userUsernameInput').readOnly = true;
            document.getElementById('userUsernameInput').title = 'لا يمكن تغيير اسم الدخول بعد الإنشاء';
            document.getElementById('userRoleInput').value = u.systemRole || 'user';
            document.getElementById('userJobInput').value = u.role || u.jobPosition || '';
            document.getElementById('userManagerInput').value = u.mgr || '';
        }

        userModal?.show();
    }

    async function deleteUserHandler(id, username) {
        const me = currentUser();
        if (me && String(me.id) === String(id)) { showStatus('لا يمكنك حذف حسابك الحالي.', true); return; }
        const target = users.find(u => String(u.id) === String(id));
        if (target && target.systemRole === 'admin') {
            const admins = users.filter(u => u.systemRole === 'admin');
            if (admins.length <= 1) { showStatus('لا يمكن حذف آخر إداري.', true); return; }
        }
        if (!confirm(`حذف المستخدم «${username}» نهائياً؟`)) return;
        try {
            const result = await apiPost('deleteUser', { editUsername: username });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل حذف المستخدم');
            showToast('تم حذف المستخدم.');
            await refreshAppCache({ silent: true });
            await loadUsers();
        } catch (e) {
            showStatus('تعذر حذف المستخدم: ' + (e.message || e), true);
        }
    }

    function setFormBusy(busy) {
        const btn = document.getElementById('saveUserBtn');
        if (!btn) return;
        btn.disabled = busy;
        btn.innerHTML = busy ? '<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الحفظ...' : '<i class="fa-solid fa-floppy-disk me-1"></i> حفظ';
    }

    async function saveUserHandler(e) {
        e.preventDefault();
        const id = String(document.getElementById('userFormId').value || '');
        const name = document.getElementById('userNameInput').value.trim();
        const username = document.getElementById('userUsernameInput').value.trim();
        const password = document.getElementById('userPasswordInput').value;
        if (!id && password.length > 0 && password.length < 4) { showStatus('كلمة المرور لا تقل عن ٤ أحرف.', true); return; }
        if (!id && password.length === 0) { showStatus('كلمة المرور مطلوبة للمستخدم الجديد.', true); return; }
        const role = document.getElementById('userRoleInput').value;
        const jobPosition = document.getElementById('userJobInput').value.trim();
        const manager = document.getElementById('userManagerInput').value.trim();

        setFormBusy(true);
        try {
            // V68: role يُفرض على الخادم من الحساب الموثّق — تصل الصلاحية الجديدة كـ systemRole.
            const payload = { username, systemRole: role, name, jobPosition, manager };
            if (password) payload.password = password;
            if (id) payload.editUsername = username;
            const result = await apiPost('saveUser', payload);
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل حفظ المستخدم');

            if (id) {
                const me = currentUser();
                if (me && String(me.id) === String(id)) {
                    // تحديث بيانات الإداري نفسه: يحاول تحديث الحالة فقط (الاسم والمهمة والمدير).
                    if (name) me.name = name;
                    if (jobPosition) me.role = jobPosition;
                    if (manager) me.mgr = manager;
                    localStorage.setItem('currentUser', JSON.stringify(me));
                    sessionStorage.setItem('currentUser', JSON.stringify(me));
                }
            }

            showToast(id ? 'تم تحديث المستخدم.' : 'تم إنشاء المستخدم.');
            userModal?.hide();
            await refreshAppCache({ silent: true });
            await loadUsers();
        } catch (e) {
            showStatus('تعذر حفظ المستخدم: ' + (e.message || e), true);
        } finally {
            setFormBusy(false);
        }
    }

    addUserBtn?.addEventListener('click', () => openUserModal(''));
    form?.addEventListener('submit', saveUserHandler);
    searchInput?.addEventListener('input', renderUsers);

    await loadUsers();

    // V72: نفس السبب — تعديل الشيت كان يحدّث الكاش ولا يحدّث هذه الشاشة.
    window.addEventListener('appDataRefreshed', async () => {
        await loadUsers();
    });
}

if (typeof registerView === 'function') registerView('users', handleUsersPage);