const ATTENDANCE_SICK_LEAVE_STATUS = 'اجازة مرضية';
const ATTENDANCE_MEDICAL_FILE_MAX_BYTES = 5 * 1024 * 1024;

function fileToBase64_(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('تعذرت قراءة ملف التقرير الطبي'));
        reader.readAsDataURL(file);
    });
}

async function handleAttendancePage() {
    const user = JSON.parse(localStorage.getItem('currentUser')) || JSON.parse(sessionStorage.getItem('currentUser'));
    const form=document.getElementById('attendanceForm'), body=document.getElementById('attendance-table-body');
    const role=String(user.role||'').toLowerCase(), statusFilter=document.getElementById('attendanceFilterStatus'), approvalFilter=document.getElementById('attendanceApprovalFilter');
    const employeeFilter=document.getElementById('attendanceEmployeeFilter'), message=document.getElementById('attendanceStatusMessage');
    const statusSelect=document.getElementById('attendanceStatus'), medicalWrap=document.getElementById('medicalReportWrap'), medicalFile=document.getElementById('medicalReportFile');
    const editStatusSelect=document.getElementById('attendanceEditStatus');
    let rows=[];
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    const canReview = role === 'admin' || role === 'manager' || role === 'auditor';
    const approveAllAttendanceBtn = document.getElementById('approveAllAttendanceBtn');
    if (approveAllAttendanceBtn) approveAllAttendanceBtn.classList.toggle('d-none', role !== 'admin' && role !== 'manager');
    approveAllAttendanceBtn?.addEventListener('click', async () => {
        if (!confirm('سيتم اعتماد جميع سجلات الدوام قيد المراجعة ضمن نطاقك الحالي. السجلات المرفوضة لن تتغير. هل تريد المتابعة؟')) return;
        const original = approveAllAttendanceBtn.innerHTML;
        approveAllAttendanceBtn.disabled = true;
        approveAllAttendanceBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>جاري الاعتماد...';
        try {
            const targetUserId = employeeFilter?.value || '';
            const result = await apiPost('approveAllAttendance', { role: user.role || '', targetUserId });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'تعذر اعتماد سجلات الدوام');
            alert(result.message || `تم اعتماد ${result.approved || 0} سجل.`);
            localStorage.removeItem(attendanceCacheKey());
            await load();
        } catch (e) {
            alert(`تعذر اعتماد الكل: ${e.message || e}`);
        } finally {
            approveAllAttendanceBtn.disabled = false;
            approveAllAttendanceBtn.innerHTML = original;
        }
    });

    const reviewAttendance = async (button, timestamp, username, status) => {
        try {
            const rejectReason = status === 'rejected' ? (prompt('سبب رفض سجل الدوام:') || '').trim() : '';
            if (status === 'rejected' && !rejectReason) { alert('يرجى كتابة سبب الرفض.'); return; }
            if (status === 'approved' && !confirm('اعتماد سجل الدوام هذا؟')) return;
            button.disabled = true;
            const original = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const result = await apiPost('approveAttendance', { timestamp, username, role: user.role || '', status, reason: rejectReason, approvedBy: user.name || '', approvedAt: new Date().toISOString() });
            if (!result || result.status !== 'success') throw new Error(result?.message || 'فشل العملية');
            localStorage.removeItem(attendanceCacheKey());
            await load();
            message.className = 'alert alert-success mt-3';
            message.textContent = status === 'approved' ? 'تم اعتماد سجل الدوام.' : 'تم رفض سجل الدوام.';
        } catch (e) {
            button.disabled = false;
            button.innerHTML = original;
            alert(`تعذر ${status === 'approved' ? 'اعتماد' : 'رفض'} سجل الدوام: ${e.message || e}\n\nتأكد من نشر النسخة المحدّثة من Apps Script.`);
        }
    };
    const bindAttendanceReview = () => {
        body.querySelectorAll('.approve-att-btn').forEach(b => b.addEventListener('click', () => reviewAttendance(b, b.dataset.ts, b.dataset.u, 'approved')));
        body.querySelectorAll('.reject-att-btn').forEach(b => b.addEventListener('click', () => reviewAttendance(b, b.dataset.ts, b.dataset.u, 'rejected')));
        body.querySelectorAll('.edit-att-btn').forEach(b => b.addEventListener('click', () => openAttendanceEdit(b)));
    };
    const render=()=>{const approvalVal=r=>r.approvalStatus==='approved'?'approved':(r.approvalStatus==='rejected'?'rejected':'pending');const filtered=rows.filter(r=>(!statusFilter.value||r.status===statusFilter.value)&&(!approvalFilter.value||approvalVal(r)===approvalFilter.value));document.getElementById('attendanceCount').textContent=`${filtered.length} سجل`;
    const emptyCols = 7;
    body.innerHTML=filtered.length?filtered.map(r=>{
        const badge = r.approvalStatus === 'approved' ? '<span class="badge bg-success">معتمد</span>' : (r.approvalStatus === 'rejected' ? '<span class="badge bg-danger">مرفوض</span>' : '<span class="badge bg-secondary">قيد المراجعة</span>');
        const mine = String(r.username || '') === String(user.username || user.name || '');
        const canEditThis = r.approvalStatus === 'rejected' && (mine || canReview);
        const review = `<td class="text-nowrap">${badge} ` +
            (canEditThis ? `<button class="btn btn-sm btn-outline-primary edit-att-btn" data-ts="${esc(r.timestamp)}" data-u="${esc(r.username)}" data-status="${esc(r.status)}" data-stmt="${esc(r.attendanceStatement || '')}" data-notes="${esc(r.notes || '')}" title="تعديل السجل المرفوض"><i class="fa-solid fa-pen"></i></button> ` : '') +
            (canReview && r.approvalStatus !== 'approved' ? `<button class="btn btn-sm btn-outline-success approve-att-btn" data-ts="${esc(r.timestamp)}" data-u="${esc(r.username)}" title="اعتماد السجل"><i class="fa-solid fa-check"></i></button> ` : '') +
            (canReview && r.approvalStatus !== 'rejected' ? `<button class="btn btn-sm btn-outline-danger reject-att-btn" data-ts="${esc(r.timestamp)}" data-u="${esc(r.username)}" title="رفض السجل"><i class="fa-solid fa-ban"></i></button>` : '') + '</td>';
        return `<tr><td dir="ltr">${esc(r.timestamp)}</td><td>${esc(r.username)}</td><td><span class="badge ${r.status==='بداية دوام'?'bg-success':'bg-secondary'}">${esc(r.status)}</span></td><td>${esc(r.attendanceStatement)}</td><td>${esc(r.notes)||'-'}</td><td>${r.medicalReportUrl?`<a href="${esc(r.medicalReportUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary"><i class="fa-solid fa-file-medical me-1"></i>عرض</a>`:'-'}</td>${review}</tr>`;
    }).join(''):`<tr><td colspan="${emptyCols}" class="text-center text-muted py-4">لا توجد سجلات مطابقة</td></tr>`;bindAttendanceReview();};

    // ---- Smart cache-first loading (instant render from localStorage, refresh
    // in the background, and keep showing the cached list if offline/failed). ----
    // V70: ربط الكاش بهوية المستخدم — المفتاح القديم كان يتقاسمه كل من
    // سجّل الدخول على نفس المتصفح، فيرى مديرٌ سجلات دوام مدير آخر.
    const attendanceCacheKey=()=>ownerScopedKey(`attendanceCache::${employeeFilter?.value||'all'}`);
    const readAttendanceCache=()=>{try{const raw=localStorage.getItem(attendanceCacheKey());if(!raw)return null;const parsed=JSON.parse(raw);return Array.isArray(parsed)?parsed:null;}catch(e){return null;}};
    const writeAttendanceCache=(data)=>{try{localStorage.setItem(attendanceCacheKey(),JSON.stringify(data));}catch(e){/* تجاهل امتلاء التخزين المحلي */}};
    const load=async()=>{
        const cached=readAttendanceCache();
        if(cached){rows=cached;render();} else {body.innerHTML='<tr><td colspan="7" class="text-center py-4">جار التحميل...</td></tr>';}
        try{
            const r=await apiGet('getAttendance',{userId:String(user.id||''),role:String(user.role||''),userName:String(user.username||user.name||''),targetUserId:employeeFilter?.value||''});
            if(!Array.isArray(r))throw Error(r.message||'تعذر تحميل السجل');
            rows=r;render();writeAttendanceCache(rows);
        }catch(e){
            if(!cached) body.innerHTML=`<tr><td colspan="7" class="text-center text-danger">${esc(e.message)}</td></tr>`;
            // إذا فيه كاش، منخليه ظاهر كما هو (أوفلاين) بدل ما نستبدله برسالة خطأ.
        }
    };
    window.addEventListener('attendanceCacheInvalidated', load);

    // Status options are pulled live from the "statusWT" sheet (auto-created
    // with defaults on first run by the backend) so the dropdown (form) and
    // the history filter always match what's configured there. Cached locally
    // too, so the dropdown appears instantly and still works offline.
    const statusCacheKey=()=>ownerScopedKey('attendanceStatusCache');
    const readStatusCache=()=>{try{const raw=localStorage.getItem(statusCacheKey());const parsed=raw?JSON.parse(raw):null;return Array.isArray(parsed)&&parsed.length?parsed:null;}catch(e){return null;}};
    const writeStatusCache=(options)=>{try{localStorage.setItem(statusCacheKey(),JSON.stringify(options));}catch(e){}};
    const applyStatusOptions=(options)=>{
        const currentValue=statusSelect.value;
        statusSelect.innerHTML=options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('');
        if(options.includes(currentValue)) statusSelect.value=currentValue;
        const currentFilter=statusFilter.value;
        statusFilter.innerHTML='<option value="">كل الحالات</option>'+options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('');
        if(options.includes(currentFilter)) statusFilter.value=currentFilter;
        if(editStatusSelect){
            const curEdit=editStatusSelect.value;
            editStatusSelect.innerHTML=options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('');
            if(options.includes(curEdit)) editStatusSelect.value=curEdit;
        }
        toggleMedicalReportField();
    };
    const loadStatusOptions=async()=>{
        const cached=readStatusCache();
        if(cached) applyStatusOptions(cached);
        try{
            const r=await apiGet('getStatusOptions');
            if(r&&r.status==='success'&&Array.isArray(r.options)&&r.options.length){applyStatusOptions(r.options);writeStatusCache(r.options);return;}
        }catch(e){console.warn('تعذر تحميل حالات الدوام من statusWT (سيتم استخدام القيم المخزنة/الافتراضية)',e);}
        if(!cached) applyStatusOptions(['بداية دوام','نهاية دوام','عطلة أسبوعية','عطلة رسمية','اجازة إدارية','اجازة مرضية','حضور إضافي']);
    };
    const toggleMedicalReportField=()=>{
        const isSick=statusSelect.value===ATTENDANCE_SICK_LEAVE_STATUS;
        medicalWrap.classList.toggle('d-none',!isSick);
        medicalFile.required=isSick;
        if(!isSick) medicalFile.value='';
    };

    // ---- V69: تعديل سجل دوام غير معتمد (المرفوض/قيد المراجعة) — المعتمد لا يُعدَّل. ----
    const attendanceEditModalEl=document.getElementById('attendanceEditModal');
    const attendanceEditModal=attendanceEditModalEl?new bootstrap.Modal(attendanceEditModalEl):null;
    const openAttendanceEdit=(button)=>{
        if(!attendanceEditModal) return;
        document.getElementById('attendanceEditTimestamp').value=button.dataset.ts||'';
        document.getElementById('attendanceEditUsername').value=button.dataset.u||'';
        const st=button.dataset.status||'';
        if(editStatusSelect){
            if(st&&[...editStatusSelect.options].some(o=>o.value===st)) editStatusSelect.value=st;
        }
        document.getElementById('attendanceEditStatement').value=button.dataset.stmt||'';
        document.getElementById('attendanceEditNotes').value=button.dataset.notes||'';
        attendanceEditModal.show();
    };
    document.getElementById('saveAttendanceEditBtn')?.addEventListener('click',async()=>{
        const timestamp=document.getElementById('attendanceEditTimestamp').value.trim();
        const username=document.getElementById('attendanceEditUsername').value.trim();
        const status=editStatusSelect?editStatusSelect.value:'';
        const statement=document.getElementById('attendanceEditStatement').value.trim();
        const notes=document.getElementById('attendanceEditNotes').value.trim();
        if(!timestamp||!username){alert('معرّف سجل الدوام مفقود.');return;}
        if(!status){alert('يرجى اختيار حالة الدوام.');return;}
        if(!statement){alert('بيان الدوام مطلوب.');return;}
        const b=document.getElementById('saveAttendanceEditBtn');
        b.disabled=true;
        const orig=b.innerHTML;
        b.innerHTML='<i class="fa-solid fa-spinner fa-spin me-1"></i> جاري الحفظ...';
        try{
            const r=await apiPost('editAttendance',{timestamp,username,status,attendanceStatement:statement,notes});
            if(!r||r.status!=='success')throw new Error(r?.message||'فشل تعديل السجل');
            if(attendanceEditModal) attendanceEditModal.hide();
            message.className='alert alert-success mt-3';
            message.textContent=r.message||'تم تعديل سجل الدوام وأصبح قيد المراجعة.';
            localStorage.removeItem(attendanceCacheKey());
            await load();
        }catch(e){
            alert(`تعذر تعديل سجل الدوام: ${e.message||e}\n\nتأكد من نشر النسخة المحدّثة من Apps Script.`);
        }finally{
            b.disabled=false;
            b.innerHTML=orig;
        }
    });

    if(role==='admin'||role==='manager'){try{const options=await fetchTeamOptions(user);employeeFilter.innerHTML='<option value="">كل الموظفين المسموح بهم</option>'+options.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');document.getElementById('attendanceEmployeeFilterWrap').classList.remove('d-none');}catch(e){console.warn(e);}}
    statusFilter.addEventListener('change',render);approvalFilter?.addEventListener('change',render);employeeFilter?.addEventListener('change',load);
    statusSelect.addEventListener('change',toggleMedicalReportField);
    await loadStatusOptions();

    form.addEventListener('submit',async e=>{
        e.preventDefault();
        const b=form.querySelector('button[type=submit]');
        b.disabled=true;
        try{
            const status=statusSelect.value;
            const payload={username:user.username||user.name,status,attendanceStatement:document.getElementById('attendanceStatement').value.trim(),notes:document.getElementById('attendanceNotes').value.trim()};
            if(status===ATTENDANCE_SICK_LEAVE_STATUS){
                const file=medicalFile.files && medicalFile.files[0];
                if(!file) throw new Error('يجب إرفاق التقرير الطبي (PDF أو صورة) عند اختيار حالة اجازة مرضية');
                if(file.size>ATTENDANCE_MEDICAL_FILE_MAX_BYTES) throw new Error('حجم ملف التقرير الطبي يتجاوز 5 ميجابايت');
                payload.medicalReportBase64=await fileToBase64_(file);
                payload.medicalReportFileName=file.name;
                payload.medicalReportMimeType=file.type||'application/octet-stream';
            }

            const saveOnlineOrQueue=async()=>{
                if(!navigator.onLine){await queueAttendanceOffline(payload);return{queued:true};}
                try{
                    const r=await apiPost('submitAttendance', payload);
                    if(!r||r.status!=='success')throw Error(r.message||'فشل الحفظ');
                    return r;
                }catch(err){
                    const networkFailure=!navigator.onLine||err instanceof TypeError||/failed to fetch|network|load failed/i.test(String(err.message||''));
                    if(networkFailure){await queueAttendanceOffline(payload);return{queued:true};}
                    throw err;
                }
            };

            const result=await saveOnlineOrQueue();
            form.reset();
            toggleMedicalReportField();
            if(result.queued){
                updateOfflineStatus();
                message.className='alert alert-warning mt-3';
                message.textContent='تم حفظ السجل محلياً وسيتم إرساله تلقائياً عند عودة الإنترنت.';
            }else{
                message.className='alert alert-success mt-3';
                message.textContent='تم تسجيل الدوام بنجاح.';
                localStorage.removeItem(attendanceCacheKey());
                await load();
            }
        }catch(err){
            message.className='alert alert-danger mt-3';
            message.textContent=err.message;
        }finally{
            b.disabled=false;
            b.innerHTML='<i class="fa-solid fa-check me-1"></i> تسجيل الدوام';
        }
    });
    // V58: عند إعادة زيارة شاشة الدوام من قائمة التنقل نُعيد تحميل السجلات.
    window.addEventListener('spaViewRevisited', async (event) => {
        if (event.detail && event.detail.route !== 'attendance') return;
        await load();
    });

    // V67: بعد انتهاء تحديث شامل للبيانات نعيد تحميل سجل الدوام عند فتح الشاشة.
    window.addEventListener('appDataRefreshed', async () => { await load(); });

    await load();
}

// V58: تسجيل شاشة الدوام في موجه الـ SPA.
if (typeof registerView === 'function') registerView('attendance', handleAttendancePage);
