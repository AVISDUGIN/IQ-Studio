import './styles.css';
import { getSupabase } from './supabase.js';

const state = {
  supabase: null,
  session: null,
  profile: null,
  roleDefinitions: [],
  route: 'tournaments',
  devOpen: false,
  devTab: 'content',
  contentTab: 'stream',
  stream: null,
  programs: [],
  videos: [],
  news: [],
  profiles: [],
  latestNotificationByUser: new Map(),
  activeProgram: null,
  userEditor: null,
  busy: false,
  configError: '',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const main = $('#main-content');
const modalRoot = $('#modal-root');
const toastRegion = $('#toast-region');
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const safeUrl = (value) => {
  try {
    const url = new URL(value, window.location.href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
};
const isLoggedIn = () => Boolean(state.session);
const hasCapability = (name) => state.profile?.roles?.some((key) => {
  const role = state.roleDefinitions.find((item) => item.role_key === key);
  return role?.capabilities?.[name] === true;
}) ?? false;
const canViewDeveloper = () => hasCapability('dashboard_view');
const canManageContent = () => hasCapability('manage_content');
const canManageUsers = () => hasCapability('manage_users');
const isBanned = () => state.profile?.banned === true;
const isSectionBlocked = (key) => state.profile?.blocked_sections?.includes(key) && !canManageUsers();
const formatDate = (value) => value
  ? new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
  : 'لم يسجل دخول بعد';
const showToast = (message, type = 'success') => {
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type === 'error' ? 'toast-error' : '');
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3800);
};
const prettyError = (error) => {
  const message = error?.message || 'حدث خطأ غير متوقع.';
  if (/failed to fetch|fetch failed|networkerror/i.test(message)) return 'تعذر الوصول إلى Supabase. تحقق من SUPABASE_URL ومفتاح anon واتصال الشبكة.';
  if (/invalid api key|invalid jwt/i.test(message)) return 'مفتاح Supabase غير صالح. استخدم المفتاح العام anon أو publishable.';
  if (/could not find the table|schema cache|relation .* does not exist/i.test(message)) return 'جداول قاعدة البيانات غير مهيأة. شغّل supabase/schema.sql في Supabase SQL Editor.';
  if (/duplicate key|already registered|unique/i.test(message)) return 'اسم المستخدم مستخدم مسبقاً.';
  if (/invalid login credentials/i.test(message)) return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
  if (/email not confirmed/i.test(message)) return 'أكد الحساب من إعدادات البريد في Supabase أو عطّل تأكيد البريد.';
  if (/permission|ليس لديك صلاحية|row-level security|policy/i.test(message)) return 'ليس لديك الإذن لتنفيذ هذا الإجراء.';
  return message;
};
const setBusy = (button, busy, label = 'جارٍ الحفظ…') => {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
  }
};

function roleBadges(profile) {
  return (profile.roles || []).map((key) => {
    const role = state.roleDefinitions.find((item) => item.role_key === key);
    if (!role) return '';
    return '<span class="role-badge" tabindex="0" title="' + escapeHtml(role.description) + '" aria-label="' +
      escapeHtml(role.label + ': ' + role.description) + '">' + escapeHtml(role.label) + '</span>';
  }).join('');
}

function renderHeader() {
  const actions = $('#header-actions');
  if (state.profile) {
    actions.innerHTML = '<span class="user-chip"><span class="avatar">' +
      escapeHtml((state.profile.username || 'IQ').slice(0, 1).toUpperCase()) + '</span><span class="user-chip-name">' +
      escapeHtml(state.profile.username) + roleBadges(state.profile) + '</span></span>' +
      (canViewDeveloper() ? '<button class="button button-quiet" data-action="open-developer">لوحة المطور</button>' : '') +
      '<button class="button button-quiet" data-action="logout">خروج</button>';
  } else {
    actions.innerHTML = '<button class="button button-quiet" data-auth="login">تسجيل الدخول</button>' +
      '<button class="button button-primary" data-auth="register">التسجيل <span aria-hidden="true">↗</span></button>';
  }
  $('#developer-button').hidden = !canViewDeveloper();
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.route === state.route));
  $('#year').textContent = String(new Date().getFullYear());
}

const pageHead = (eyebrow, title, description, icon) =>
  '<section class="page-heading"><div><span class="eyebrow">' + (icon || '') + ' ' + escapeHtml(eyebrow) +
  '</span><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(description) + '</p></div>' +
  '<span class="heading-orbit" aria-hidden="true"></span></section>';

const connectionNotice = () => {
  if (!state.configError) return '';
  const schemaMissing = /جداول قاعدة البيانات غير مهيأة/.test(state.configError);
  const title = schemaMissing ? 'إعداد قاعدة البيانات مطلوب' : 'إعداد الاتصال مطلوب';
  const nextStep = schemaMissing
    ? 'افتح Supabase Dashboard → SQL Editor، شغّل ملف supabase/schema.sql بالكامل، ثم أعد تحميل الموقع.'
    : 'أنشئ ملفاً باسم .env من .env.example، وضع Project URL الحقيقي والمفتاح العام، ثم أعد تشغيل الموقع.';
  return '<div class="setup-notice"><strong>' + title + '</strong><p>' + escapeHtml(state.configError) +
    '</p><span>' + escapeHtml(nextStep) + '</span></div>';
};

function streamCard() {
  if (!isLoggedIn()) {
    return '<section class="stream-card stream-locked"><div class="stream-art"><span class="live-dot"></span>' +
      '<div class="lock-icon">⌑</div><h2>البث المباشر</h2><p>سجّل دخولك للانضمام إلى البث ومتابعة المنافسات.</p>' +
      '<button class="button button-primary" data-auth="login">تسجيل الدخول لمشاهدة البث <span>↗</span></button>' +
      '<div class="stream-lines"></div></div><div class="stream-meta"><div><span class="meta-label">حالة البث</span>' +
      '<strong class="status-pill status-muted">يتطلب تسجيل الدخول</strong></div><span class="meta-caption">الدخول متاح للأعضاء فقط</span></div></section>';
  }
  if (isBanned()) {
    return '<section class="stream-card"><div class="empty-state"><span class="empty-icon">⛔</span><h2>الحساب موقوف</h2><p>تم تعطيل هذا الحساب. تواصل مع إدارة IQ Studio.</p></div></section>';
  }
  if (isSectionBlocked('tournaments')) {
    return '<section class="stream-card"><div class="empty-state"><span class="empty-icon">⌑</span><h2>ليس لديك الإذن للدخول</h2><p>تم إغلاق قسم البطولات لهذا الحساب.</p></div></section>';
  }
  const stream = state.stream;
  if (!stream) {
    return '<section class="stream-card"><div class="stream-art stream-offline"><span class="empty-icon">◉</span><h2>لا يوجد بث مباشر الآن</h2>' +
      '<p>تابع المقاطع والأخبار، وسنخبرك عند عودة البث.</p></div><div class="stream-meta"><div><span class="meta-label">حالة البث</span>' +
      '<strong class="status-pill status-muted">غير مباشر</strong></div><span class="meta-caption">تأكد من العودة قريباً</span></div></section>';
  }
  const live = stream.status === 'live';
  const paused = stream.status === 'paused';
  const statusLabel = live ? 'مباشر الآن' : paused ? 'متوقف مؤقتاً' : 'انتهى البث';
  const previewUrl = safeUrl(stream.thumbnail_url);
  return '<section class="stream-card"><div class="stream-art stream-active" ' +
    (previewUrl ? 'style="--stream-image:url(&quot;' + escapeHtml(previewUrl) + '&quot;)"' : '') + '>' +
    '<span class="live-dot ' + (live ? '' : 'dot-muted') + '"></span><div class="stream-art-copy"><span class="eyebrow">IQ LIVE</span>' +
    '<h2>' + (live ? 'البث المباشر الآن' : paused ? 'البث متوقف مؤقتاً' : 'البث الأخير') + '</h2><p>' +
    escapeHtml(stream.description || 'تابع التحدي مباشرة من قناة IQ Studio.') + '</p>' +
    (live || paused ? '<a class="button button-primary" href="' + escapeHtml(safeUrl(stream.url)) + '" target="_blank" rel="noopener noreferrer">فتح البث <span>↗</span></a>' : '') +
    '</div><div class="stream-lines"></div></div><div class="stream-meta"><div><span class="meta-label">حالة البث</span>' +
    '<strong class="status-pill ' + (live ? 'status-live' : 'status-muted') + '">' + statusLabel + '</strong></div>' +
    '<span class="meta-caption">' + escapeHtml(formatDate(stream.updated_at)) + '</span></div></section>';
}

function videoCard(video) {
  const thumbnail = safeUrl(video.thumbnail_url);
  const videoUrl = safeUrl(video.video_url);
  return '<article class="video-card"><a class="video-thumb" href="' + escapeHtml(videoUrl || '#') +
    '" target="_blank" rel="noopener noreferrer" aria-label="مشاهدة ' + escapeHtml(video.title) + '">' +
    (thumbnail ? '<img src="' + escapeHtml(thumbnail) + '" alt="" loading="lazy" />' : '<span class="thumb-placeholder">▶</span>') +
    '<span class="play-button">▶</span><span class="video-duration">IQ CLIP</span></a><div class="video-info">' +
    '<span class="content-kicker">مقطع من IQ Studio</span><h3>' + escapeHtml(video.title) + '</h3>' +
    '<p>' + escapeHtml(video.description || '') + '</p><span class="content-date">' + escapeHtml(formatDate(video.created_at)) + '</span></div></article>';
}

function renderTournaments() {
  const blocked = isSectionBlocked('tournaments');
  main.innerHTML = '<div class="content-wrap">' +
    pageHead('ساحة المنافسة', 'بطولات ومنافسات', 'عش أجواء التحدي، تابع البث المباشر، واكتشف أبرز لحظات مجتمع IQ Studio.', '✦') +
    connectionNotice() +
    (blocked ? '<div class="permission-banner">ليس لديك الإذن للدخول إلى قسم البطولات.</div>' : streamCard()) +
    '<section class="section-block"><div class="section-title"><div><span class="eyebrow">من الأرشيف</span><h2>مقاطع المجتمع</h2>' +
    '<p>لقطات ومنافسات يمكنك مشاهدتها دون تسجيل حساب.</p></div><span class="count-chip">' + state.videos.length + ' مقطع</span></div>' +
    (state.videos.length ? '<div class="video-grid">' + state.videos.map(videoCard).join('') + '</div>' : emptyCard('لا توجد مقاطع بعد', 'ستظهر المقاطع هنا عند إضافتها.')) +
    '</section></div>';
}

function programCard(program) {
  const image = safeUrl(program.image_url);
  return '<button class="program-card" data-action="program-detail" data-id="' + escapeHtml(program.id) + '">' +
    '<span class="program-cover">' + (image ? '<img src="' + escapeHtml(image) + '" alt="" loading="lazy" />' : '<span class="cover-monogram">IQ</span>') +
    '<span class="cover-arrow">↗</span></span><span class="program-card-text"><span class="content-kicker">برنامج IQ</span>' +
    '<strong>' + escapeHtml(program.title) + '</strong><span>' + escapeHtml(program.description || 'استكشف تفاصيل البرنامج.') + '</span></span></button>';
}

function renderPrograms() {
  main.innerHTML = '<div class="content-wrap">' +
    pageHead('أدواتنا', 'برامجنا', 'برامج وأدوات صممناها لتجعل تجربتك مع IQ Studio أفضل.', '⬡') +
    connectionNotice() +
    (state.programs.length ? '<div class="program-grid">' + state.programs.map(programCard).join('') + '</div>' :
      emptyCard('برامجنا قريباً', 'ستجد هنا البرامج المتاحة للتنزيل والتعريف بها.')) + '</div>';
}

function newsCard(item) {
  const image = safeUrl(item.image_url);
  return '<article class="news-card"><div class="news-image">' + (image ? '<img src="' + escapeHtml(image) +
    '" alt="" loading="lazy" />' : '<span class="news-monogram">IQ <i>NEWS</i></span>') + '</div>' +
    '<div class="news-copy"><span class="content-date">' + escapeHtml(formatDate(item.created_at)) +
    '</span><h2>' + escapeHtml(item.title) + '</h2><p>' + escapeHtml(item.body) + '</p></div></article>';
}

function renderNews() {
  main.innerHTML = '<div class="content-wrap">' +
    pageHead('آخر المستجدات', 'أخبار IQ Studio', 'كل جديد عن الموقع والبطولات، في مكان واحد.', '◌') +
    connectionNotice() +
    (state.news.length ? '<div class="news-list">' + state.news.map(newsCard).join('') + '</div>' :
      emptyCard('لا توجد أخبار حالياً', 'سيظهر آخر المستجدات هنا عند نشرها.')) + '</div>';
}

function renderServers() {
  main.innerHTML = '<div class="content-wrap">' +
    pageHead('قريباً', 'سيرفرات المجتمع', 'مساحات اللعب والتواصل الخاصة بمجتمع IQ Studio.', '⌘') +
    connectionNotice() +
    '<section class="servers-empty"><span class="server-orbit">◉</span><span class="eyebrow">حالة السيرفرات</span>' +
    '<h2>لا يوجد اي سيرفر</h2><p>لم تتم إضافة سيرفرات حتى الآن. تفقد الصفحة لاحقاً.</p>' +
    '<span class="server-status"><i></i> لا توجد سيرفرات متاحة</span></section></div>';
}

function emptyCard(title, body) {
  return '<div class="empty-card"><span class="empty-spark">✦</span><strong>' + escapeHtml(title) + '</strong><p>' +
    escapeHtml(body) + '</p></div>';
}

function renderPage() {
  if (state.route === 'programs') renderPrograms();
  else if (state.route === 'news') renderNews();
  else if (state.route === 'servers') renderServers();
  else renderTournaments();
  renderHeader();
}

function modal(title, eyebrow, content, extraClass = '') {
  modalRoot.innerHTML = '<div class="modal-backdrop" data-action="backdrop-close"><section class="modal ' + extraClass +
    '" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '"><div class="modal-head"><div><span class="eyebrow">' +
    escapeHtml(eyebrow) + '</span><h2>' + escapeHtml(title) + '</h2></div><button class="icon-button" data-action="close-modal" aria-label="إغلاق">×</button></div>' +
    '<div class="modal-body">' + content + '</div></section></div>';
  $('.modal-backdrop', modalRoot)?.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
}
function closeModal() {
  const wasDeveloper = Boolean($('.developer-modal', modalRoot));
  const wasUserEditor = Boolean($('.user-editor-modal', modalRoot));
  modalRoot.innerHTML = '';
  if (wasDeveloper) state.devOpen = false;
  state.activeProgram = null;
  state.userEditor = null;
  if (wasUserEditor && state.devOpen) renderDeveloper();
}

function authModal(mode = 'login') {
  const register = mode === 'register';
  const content = '<form id="auth-form" class="form-stack"><label class="field"><span>اسم المستخدم</span>' +
    '<input name="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+" autocomplete="username" required placeholder="مثال: iq_member" /></label>' +
    (register ? '<label class="field"><span>الجنس</span><select name="gender" required><option value="male">ذكر</option><option value="female">أنثى</option></select></label>' : '') +
    '<label class="field"><span>كلمة المرور</span><input name="password" type="password" minlength="8" autocomplete="' +
    (register ? 'new-password' : 'current-password') + '" required placeholder="٨ أحرف على الأقل" /></label>' +
    '<p class="form-hint">يتم إنشاء الحساب وتأمينه عبر Supabase Auth.</p><button class="button button-primary button-wide" type="submit">' +
    (register ? 'إنشاء الحساب' : 'تسجيل الدخول') + ' <span>↗</span></button>' +
    '<button class="text-button" type="button" data-action="switch-auth" data-mode="' + (register ? 'login' : 'register') + '">' +
    (register ? 'لديك حساب؟ تسجيل الدخول' : 'ليس لديك حساب؟ إنشاء حساب') + '</button></form>';
  modal(register ? 'إنشاء حساب جديد' : 'تسجيل الدخول', 'مرحباً بك في IQ Studio', content, 'auth-modal');
  $('#auth-form input[name="username"]')?.focus();
}

async function openProgram(programId) {
  const program = state.programs.find((item) => item.id === programId);
  if (!program) return;
  state.activeProgram = program;
  let downloadUrl = '';
  if (isLoggedIn() && !isBanned() && !isSectionBlocked('program_downloads')) {
    const { data, error } = await state.supabase.from('program_downloads').select('download_url').eq('program_id', program.id).maybeSingle();
    if (error && !/permission|row-level security/i.test(error.message)) showToast(prettyError(error), 'error');
    downloadUrl = data?.download_url || '';
  }
  const image = safeUrl(program.image_url);
  const hasAccess = isLoggedIn() && !isBanned() && !isSectionBlocked('program_downloads');
  const downloadPrompt = isSectionBlocked('program_downloads')
    ? '<div class="permission-banner compact">ليس لديك الإذن للدخول إلى التنزيلات.</div>'
    : '<button class="button button-primary button-wide" data-auth="login">سجّل الدخول لتنزيل البرنامج</button>';
  const content = '<div class="program-detail">' + (image ? '<img class="detail-image" src="' + escapeHtml(image) + '" alt="' + escapeHtml(program.title) + '" />' :
    '<div class="detail-image detail-placeholder">IQ</div>') + '<span class="eyebrow">IQ PROGRAM</span><h3>' + escapeHtml(program.title) +
    '</h3><p>' + escapeHtml(program.description) + '</p>' +
      (hasAccess ? (downloadUrl ? '<a class="button button-primary button-wide" href="' + escapeHtml(safeUrl(downloadUrl)) +
      '" target="_blank" rel="noopener noreferrer">تنزيل البرنامج <span>↓</span></a>' : '<div class="inline-note">رابط التنزيل غير متوفر حالياً.</div>') :
      downloadPrompt) + '</div>';
  modal('تفاصيل البرنامج', 'برامجنا', content, 'detail-modal');
}

async function loadStream() {
  state.stream = null;
  if (!isLoggedIn() || isBanned() || isSectionBlocked('tournaments')) return;
  const { data, error } = await state.supabase.from('live_stream').select('*').eq('id', 1).maybeSingle();
  if (!error && data && data.status !== 'offline') state.stream = data;
  else if (error && !/permission|row-level security/i.test(error.message)) console.warn(error);
}
async function loadPublicData() {
  if (!state.supabase) return;
  const results = await Promise.all([
    state.supabase.from('programs').select('id,title,image_url,description,created_at').order('created_at', { ascending: false }),
    state.supabase.from('videos').select('*').order('created_at', { ascending: false }),
    state.supabase.from('news').select('*').order('created_at', { ascending: false }),
    state.supabase.from('role_definitions').select('*').order('created_at', { ascending: true }),
  ]);
  if (!results[0].error) state.programs = results[0].data || [];
  if (!results[1].error) state.videos = results[1].data || [];
  if (!results[2].error) state.news = results[2].data || [];
  if (!results[3].error) state.roleDefinitions = results[3].data || [];
  const firstDataError = results.find((result) => result.error)?.error;
  state.configError = firstDataError ? prettyError(firstDataError) : '';
  await loadStream();
  renderPage();
  if (state.devOpen) renderDeveloper();
}

async function syncAuth(session) {
  state.session = session;
  state.profile = null;
  if (session?.user) {
    const { data, error } = await state.supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (!error) state.profile = data;
    if (state.profile?.banned) {
      await state.supabase.auth.signOut();
      state.session = null;
      state.profile = null;
      showToast('هذا الحساب محظور. تواصل مع إدارة الموقع.', 'error');
    }
    if (state.profile && !state.profile.banned && !session.user.last_sign_in_at) {
      await state.supabase.rpc('record_my_login').catch(() => {});
    }
  }
  await checkLatestNotification();
  renderHeader();
  await loadStream();
  renderPage();
  if (state.devOpen) renderDeveloper();
}

async function checkLatestNotification() {
  if (!state.session?.user || isBanned() || isSectionBlocked('tournaments')) return;
  const { data, error } = await state.supabase.from('notifications').select('id,title,body,created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !data) return;
  const userId = state.session.user.id;
  const previousId = state.latestNotificationByUser.get(userId);
  state.latestNotificationByUser.set(userId, data.id);
  const isRecent = Date.now() - new Date(data.created_at).getTime() < 5 * 60 * 1000;
  if ((previousId && previousId !== data.id) || (!previousId && isRecent)) {
    showToast(data.title + (data.body ? ': ' + data.body : ''), 'success');
  }
}

function openDeveloper() {
  if (!canViewDeveloper()) return showToast('ليس لديك الإذن للدخول.', 'error');
  state.devOpen = true;
  state.devTab = 'content';
  state.contentTab = 'stream';
  renderDeveloper();
}

function devNav() {
  return '<div class="dev-tabs" role="tablist"><button class="' + (state.devTab === 'content' ? 'selected' : '') +
    '" data-action="dev-tab" data-tab="content">البطولات والبرامج والأخبار</button>' +
    (canManageUsers() ? '<button class="' + (state.devTab === 'users' ? 'selected' : '') +
      '" data-action="dev-tab" data-tab="users">إدارة المستخدمين</button><button class="' + (state.devTab === 'roles' ? 'selected' : '') +
      '" data-action="dev-tab" data-tab="roles">الرتب والصلاحيات</button>' : '') + '</div>';
}

function renderDeveloper() {
  if (!state.devOpen || !canViewDeveloper()) return;
  let body = '';
  if (state.devTab === 'users') body = canManageUsers() ? renderUsersPanel() : '<p>ليس لديك الإذن.</p>';
  else if (state.devTab === 'roles') body = canManageUsers() ? renderRolesPanel() : '<p>ليس لديك الإذن.</p>';
  else body = renderContentPanel();
  modal('خيارات المطور', 'لوحة IQ Studio', devNav() + '<div class="dev-panel">' + body + '</div>', 'developer-modal');
}

function renderContentPanel() {
  const tabs = [
    ['stream', 'البطولات والبث'], ['videos', 'المقاطع'], ['programs', 'البرامج'], ['news', 'الأخبار'],
  ];
  const nav = '<div class="sub-tabs">' + tabs.map(([key, label]) => '<button class="' + (state.contentTab === key ? 'selected' : '') +
    '" data-action="content-tab" data-tab="' + key + '">' + label + '</button>').join('') + '</div>';
  const readOnly = !canManageContent();
  let panel = '';
  if (state.contentTab === 'stream') panel = renderStreamAdmin(readOnly);
  if (state.contentTab === 'videos') panel = renderVideosAdmin(readOnly);
  if (state.contentTab === 'programs') panel = renderProgramsAdmin(readOnly);
  if (state.contentTab === 'news') panel = renderNewsAdmin(readOnly);
  return (readOnly ? '<div class="read-only-note">أنت في وضع المشاهدة. لا تملك صلاحية التعديل أو الحذف.</div>' : '') + nav + panel;
}

function renderStreamAdmin(readOnly) {
  const stream = state.stream;
  let content = '';
  if (stream?.status === 'live' || stream?.status === 'paused') {
    content = '<div class="admin-live-card"><div><span class="status-pill ' + (stream.status === 'live' ? 'status-live' : 'status-muted') +
      '">' + (stream.status === 'live' ? 'مباشر' : 'متوقف مؤقتاً') + '</span><h3>' + escapeHtml(stream.description || 'بث IQ Studio') +
      '</h3><a href="' + escapeHtml(safeUrl(stream.url)) + '" target="_blank" rel="noopener noreferrer">فتح رابط البث ↗</a></div>' +
      (!readOnly ? '<div class="button-row"><button class="button button-secondary" data-action="pause-stream">' +
        (stream.status === 'live' ? 'توقف البث مؤقتاً' : 'استئناف البث') + '</button><button class="button button-danger" data-action="stop-stream">إيقاف البث النهائي</button></div>' : '') + '</div>';
  } else {
    content = '<div class="inline-note">' + (stream?.status === 'offline' ? 'البث متوقف حالياً.' : 'لا يوجد بث مُعدّ.') + '</div>';
  }
  if (!readOnly && stream?.status !== 'live' && stream?.status !== 'paused') {
    content += '<form id="stream-form" class="admin-form"><div class="form-heading"><h3>بدء بث جديد</h3><span>أضف رابط البث ووصفاً وصورة معاينة.</span></div>' +
      '<label class="field"><span>رابط البث</span><input name="url" type="url" required placeholder="https://www.tiktok.com/..." /></label>' +
      '<label class="field"><span>الوصف</span><input name="description" required maxlength="180" placeholder="نهائي بطولة IQ" /></label>' +
      '<label class="field"><span>رابط الصورة المصغرة</span><input name="thumbnail_url" type="url" placeholder="https://..." /></label>' +
      '<label class="checkbox-field"><input type="checkbox" name="notify" /><span>إرسال إشعار للمستخدمين</span></label>' +
      '<button class="button button-primary" type="submit">بدء البث <span>↗</span></button></form>';
  }
  return '<div class="admin-section-head"><div><h3>إدارة البث المباشر</h3><p>تُتاح مشاهدة البث للمستخدمين المسجلين فقط.</p></div>' +
    '<span class="section-icon">◉</span></div>' + content;
}

function renderVideosAdmin(readOnly) {
  const list = state.videos.length ? '<div class="admin-list">' + state.videos.map((video) =>
    '<div class="admin-list-row"><span class="row-art">▶</span><span class="row-text"><strong>' + escapeHtml(video.title) +
    '</strong><small>' + escapeHtml(video.video_url) + '</small></span>' +
    (!readOnly ? '<button class="icon-button danger-text" data-action="delete-item" data-table="videos" data-id="' + escapeHtml(video.id) + '" aria-label="حذف">×</button>' : '') + '</div>').join('') + '</div>' :
    '<div class="inline-note">لا توجد مقاطع مضافة.</div>';
  const form = readOnly ? '' : '<form id="video-form" class="admin-form"><div class="form-heading"><h3>إضافة مقطع</h3><span>الصورة والرابط المباشر يظهران للجميع.</span></div>' +
    '<label class="field"><span>عنوان المقطع</span><input name="title" required maxlength="120" /></label>' +
    '<label class="field"><span>رابط الفيديو</span><input name="video_url" type="url" required placeholder="https://..." /></label>' +
    '<label class="field"><span>رابط الصورة المصغرة</span><input name="thumbnail_url" type="url" placeholder="https://..." /></label>' +
    '<label class="field"><span>الوصف</span><textarea name="description" rows="2"></textarea></label>' +
    '<button class="button button-primary" type="submit">إضافة المقطع</button></form>';
  return '<div class="admin-section-head"><div><h3>مقاطع الفيديو</h3><p>تظل المقاطع متاحة للمشاهدة من دون تسجيل.</p></div></div>' + list + form;
}

function renderProgramsAdmin(readOnly) {
  const list = state.programs.length ? '<div class="admin-list">' + state.programs.map((program) =>
    '<div class="admin-list-row"><span class="row-art">IQ</span><span class="row-text"><strong>' + escapeHtml(program.title) +
    '</strong><small>' + escapeHtml(program.description) + '</small></span>' +
    (!readOnly ? '<button class="button button-quiet button-small" data-action="edit-program" data-id="' + escapeHtml(program.id) + '">تعديل</button>' +
      '<button class="icon-button danger-text" data-action="delete-program" data-id="' + escapeHtml(program.id) + '" aria-label="حذف">×</button>' : '') + '</div>').join('') + '</div>' :
    '<div class="inline-note">لا توجد برامج مضافة.</div>';
  return '<div class="admin-section-head"><div><h3>البرامج</h3><p>روابط التنزيل محفوظة منفصلة وتُحمى حسب صلاحية المستخدم.</p></div></div>' + list +
    (readOnly ? '' : programForm());
}

function programForm(program = null) {
  return '<form id="program-form" class="admin-form"><div class="form-heading"><h3>' + (program ? 'تعديل البرنامج' : 'إضافة برنامج جديد') +
    '</h3><span>أضف وصف البرنامج ورابط التنزيل المباشر.</span></div><input type="hidden" name="id" value="' + escapeHtml(program?.id || '') + '" />' +
    '<label class="field"><span>اسم البرنامج</span><input name="title" required maxlength="100" value="' + escapeHtml(program?.title || '') + '" /></label>' +
    '<label class="field"><span>رابط صورة البرنامج</span><input name="image_url" type="url" value="' + escapeHtml(program?.image_url || '') + '" placeholder="https://..." /></label>' +
    '<label class="field"><span>رابط التحميل المباشر</span><input name="download_url" type="url" required value="' + escapeHtml(program?.download_url || '') + '" placeholder="https://..." /></label>' +
    '<label class="field"><span>وصف البرنامج</span><textarea name="description" rows="3" required>' + escapeHtml(program?.description || '') + '</textarea></label>' +
    '<div class="button-row"><button class="button button-primary" type="submit">' + (program ? 'حفظ التعديلات' : 'إضافة البرنامج') + '</button>' +
    (program ? '<button class="button button-quiet" type="button" data-action="cancel-edit-program">إلغاء</button>' : '') + '</div></form>';
}

function renderNewsAdmin(readOnly) {
  const list = state.news.length ? '<div class="admin-list">' + state.news.map((item) =>
    '<div class="admin-list-row"><span class="row-art">N</span><span class="row-text"><strong>' + escapeHtml(item.title) +
    '</strong><small>' + escapeHtml(item.body) + '</small></span>' +
    (!readOnly ? '<button class="icon-button danger-text" data-action="delete-item" data-table="news" data-id="' + escapeHtml(item.id) + '" aria-label="حذف">×</button>' : '') + '</div>').join('') + '</div>' :
    '<div class="inline-note">لا توجد أخبار منشورة.</div>';
  return '<div class="admin-section-head"><div><h3>الأخبار</h3><p>انشر مستجدات البطولات والموقع.</p></div></div>' + list +
    (readOnly ? '' : '<form id="news-form" class="admin-form"><div class="form-heading"><h3>نشر خبر</h3></div>' +
      '<label class="field"><span>عنوان الخبر</span><input name="title" required maxlength="140" /></label>' +
      '<label class="field"><span>رابط صورة الخبر</span><input name="image_url" type="url" placeholder="https://..." /></label>' +
      '<label class="field"><span>نص الخبر</span><textarea name="body" rows="4" required></textarea></label>' +
      '<button class="button button-primary" type="submit">نشر الخبر</button></form>');
}

function renderUsersPanel() {
  const rows = state.profiles.map((profile) => '<tr><td><div class="user-table-name"><span class="avatar">' +
    escapeHtml(profile.username.slice(0, 1).toUpperCase()) + '</span><div><strong>' + escapeHtml(profile.username) +
    '</strong><div class="role-stack">' + roleBadges(profile) + '</div></div></div></td><td>' +
    (profile.gender === 'female' ? 'أنثى' : 'ذكر') + '</td><td class="date-cell">' + escapeHtml(formatDate(profile.last_sign_in_at)) +
    '</td><td><span class="status-pill ' + (profile.banned ? 'status-blocked' : 'status-active') + '">' +
    (profile.banned ? 'محظور' : 'نشط') + '</span></td><td><button class="button button-quiet button-small" data-action="edit-user" data-id="' +
    escapeHtml(profile.id) + '">إدارة</button></td></tr>').join('');
  return '<div class="admin-section-head"><div><h3>إدارة المستخدمين</h3><p>الحسابات المسجلة، حالة الدخول، الرتب، وتقييد الأقسام.</p></div>' +
    '<button class="button button-secondary button-small" data-action="refresh-users">تحديث القائمة</button></div>' +
    (state.profiles.length ? '<div class="table-wrap"><table class="users-table"><thead><tr><th>المستخدم والرتب</th><th>الجنس</th><th>آخر دخول</th><th>الحالة</th><th></th></tr></thead><tbody>' + rows +
      '</tbody></table></div>' : '<div class="inline-note">لا يوجد مستخدمون للعرض أو لا تملك صلاحية عرضهم.</div>') +
    '<p class="table-note">يُسجّل آخر دخول من وقت قاعدة البيانات، ويُعرض بالتوقيت المحلي لهذا الجهاز.</p>';
}

function renderRolesPanel() {
  const roles = state.roleDefinitions.map((role) => '<div class="role-admin-row"><div><span class="role-badge">' +
    escapeHtml(role.label) + '</span><p>' + escapeHtml(role.description) + '</p><code>' + escapeHtml(role.role_key) + '</code></div>' +
    '<div class="capability-list">' + (role.capabilities?.dashboard_view ? '<span>مشاهدة اللوحة</span>' : '') +
    (role.capabilities?.manage_content ? '<span>إدارة المحتوى</span>' : '') +
    (role.capabilities?.manage_users ? '<span>إدارة المستخدمين</span>' : '') +
    (!Object.values(role.capabilities || {}).some(Boolean) ? '<span>صلاحيات العضو الافتراضية</span>' : '') + '</div>' +
    (!role.is_system ? '<button class="button button-quiet button-small danger-text" data-action="delete-role" data-id="' + escapeHtml(role.role_key) + '">حذف</button>' : '') +
    '</div>').join('');
  return '<div class="admin-section-head"><div><h3>الرتب والصلاحيات</h3><p>امنح المستخدم أكثر من رتبة، واضبط الصلاحيات التي تتضمنها الرتبة.</p></div></div>' +
    '<div class="roles-list">' + roles + '</div><form id="role-form" class="admin-form"><div class="form-heading"><h3>إنشاء رتبة مخصصة</h3>' +
    '<span>تظهر أوصاف الرتب عند المرور عليها في قائمة المستخدمين.</span></div><div class="form-grid-two">' +
    '<label class="field"><span>معرّف بالإنجليزية</span><input name="role_key" pattern="[a-z][a-z0-9_]+" required placeholder="event_moderator" /></label>' +
    '<label class="field"><span>اسم الرتبة</span><input name="label" required maxlength="40" placeholder="مشرف البطولات" /></label></div>' +
    '<label class="field"><span>وصف الصلاحيات</span><textarea name="description" rows="2" required></textarea></label>' +
    '<div class="permission-options"><label class="checkbox-field"><input type="checkbox" name="dashboard_view" /><span>مشاهدة لوحة المطور</span></label>' +
    '<label class="checkbox-field"><input type="checkbox" name="manage_content" /><span>إدارة المحتوى</span></label>' +
    '<label class="checkbox-field"><input type="checkbox" name="manage_users" /><span>إدارة المستخدمين والرتب</span></label></div>' +
    '<button class="button button-primary" type="submit">إنشاء الرتبة</button></form>';
}

async function refreshUsers() {
  const { data, error } = await state.supabase.from('profiles').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  state.profiles = data || [];
  state.roleDefinitions = (await state.supabase.from('role_definitions').select('*').order('created_at')).data || state.roleDefinitions;
  renderDeveloper();
}

function userEditorModal(user) {
  const userRoles = user.roles || [];
  const roleInputs = state.roleDefinitions.map((role) => '<label class="checkbox-field role-option"><input type="checkbox" name="roles" value="' +
    escapeHtml(role.role_key) + '" ' + (userRoles.includes(role.role_key) ? 'checked' : '') + ' /><span class="role-badge" title="' +
    escapeHtml(role.description) + '">' + escapeHtml(role.label) + '</span><small>' + escapeHtml(role.description) + '</small></label>').join('');
  const sections = ['tournaments', 'program_downloads'];
  const sectionInputs = sections.map((key) => '<label class="checkbox-field"><input type="checkbox" name="blocked_sections" value="' + key + '" ' +
    ((user.blocked_sections || []).includes(key) ? 'checked' : '') + ' /><span>' +
    (key === 'tournaments' ? 'إغلاق الدخول إلى البطولات' : 'إغلاق تنزيل البرامج') + '</span></label>').join('');
  modal('إدارة حساب ' + user.username, 'المستخدمون', '<form id="user-form" class="form-stack"><input type="hidden" name="id" value="' +
    escapeHtml(user.id) + '" /><div class="user-editor-summary"><span class="avatar">' + escapeHtml(user.username.slice(0, 1).toUpperCase()) +
    '</span><div><strong>' + escapeHtml(user.username) + '</strong><small>آخر دخول: ' + escapeHtml(formatDate(user.last_sign_in_at)) +
    '</small></div></div><label class="checkbox-field ban-toggle"><input type="checkbox" name="banned" ' + (user.banned ? 'checked' : '') +
    ' /><span>حظر الحساب</span></label><div class="editor-section"><h3>الأقسام المقفلة</h3>' + sectionInputs +
    '</div><div class="editor-section"><h3>الرتب (يمكن اختيار أكثر من رتبة)</h3><div class="role-options">' + roleInputs +
    '</div></div><div class="button-row"><button class="button button-primary" type="submit">حفظ الصلاحيات</button>' +
    '<button class="button button-quiet" type="button" data-action="close-modal">إلغاء</button></div></form>', 'user-editor-modal');
}

function askConfirm(message) {
  return window.confirm(message);
}

async function recordLogin() {
  const { error } = await state.supabase.rpc('record_my_login');
  if (error) console.warn(error);
}
function usernameEmail(username) {
  return username.trim().toLowerCase() + '@users.iqstudio.invalid';
}

async function onAuthSubmit(form) {
  if (!state.supabase) return showToast('أكمل إعداد Supabase في ملف .env قبل تسجيل الدخول أو إنشاء حساب.', 'error');
  const data = new FormData(form);
  const username = String(data.get('username') || '').trim();
  const password = String(data.get('password') || '');
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return showToast('استخدم 3 إلى 24 حرفاً أو رقماً أو شرطة سفلية لاسم المستخدم.', 'error');
  const register = Boolean(data.get('gender'));
  const submit = $('button[type="submit"]', form);
  setBusy(submit, true);
  try {
    if (register) {
      const { data: result, error } = await state.supabase.auth.signUp({
        email: usernameEmail(username),
        password,
        options: { data: { username, gender: data.get('gender') } },
      });
      if (error) throw error;
      closeModal();
      if (result.session) {
        await recordLogin();
        await syncAuth(result.session);
        showToast('تم إنشاء الحساب. أهلاً بك في IQ Studio.');
      } else {
        showToast('تم إرسال طلب التسجيل. راجع إعداد تأكيد البريد في Supabase.');
      }
    } else {
      const { data: result, error } = await state.supabase.auth.signInWithPassword({
        email: usernameEmail(username), password,
      });
      if (error) throw error;
      await recordLogin();
      closeModal();
      await syncAuth(result.session);
      showToast('تم تسجيل الدخول بنجاح.');
    }
  } catch (error) {
    showToast(prettyError(error), 'error');
  } finally {
    setBusy(submit, false);
  }
}

async function onStreamSubmit(form) {
  if (!canManageContent()) return showToast('ليس لديك الإذن لتنفيذ هذا الإجراء.', 'error');
  const data = new FormData(form);
  const url = safeUrl(String(data.get('url') || ''));
  const thumbnail = String(data.get('thumbnail_url') || '').trim();
  if (!url || (thumbnail && !safeUrl(thumbnail))) return showToast('أدخل روابط تبدأ بـ https:// أو http://.', 'error');
  const button = $('button[type="submit"]', form);
  setBusy(button, true, 'جارٍ بدء البث…');
  const record = { id: 1, url, description: String(data.get('description') || '').trim(), thumbnail_url: thumbnail, status: 'live', updated_at: new Date().toISOString() };
  try {
    const { error } = await state.supabase.from('live_stream').upsert(record, { onConflict: 'id' });
    if (error) throw error;
    if (data.get('notify')) {
      const { error: notifyError } = await state.supabase.from('notifications').insert({
        title: 'بدأ بث IQ Studio', body: record.description,
      });
      if (notifyError) throw notifyError;
    }
    state.stream = record;
    state.contentTab = 'stream';
    showToast('بدأ البث وتم حفظ بياناته.');
    renderDeveloper();
    renderPage();
  } catch (error) { showToast(prettyError(error), 'error'); }
  finally { setBusy(button, false); }
}

async function updateStreamStatus(status) {
  if (!canManageContent()) return;
  const { data, error } = await state.supabase.from('live_stream').update({ status, updated_at: new Date().toISOString() }).eq('id', 1).select().single();
  if (error) return showToast(prettyError(error), 'error');
  state.stream = status === 'offline' ? null : data;
  renderDeveloper();
  renderPage();
  showToast(status === 'offline' ? 'تم إيقاف البث.' : status === 'paused' ? 'تم إيقاف البث مؤقتاً.' : 'تم استئناف البث.');
}

async function onVideoSubmit(form) {
  const data = new FormData(form);
  const record = {
    title: String(data.get('title') || '').trim(),
    video_url: safeUrl(String(data.get('video_url') || '')),
    thumbnail_url: String(data.get('thumbnail_url') || '').trim(),
    description: String(data.get('description') || '').trim(),
  };
  if (!record.video_url || (record.thumbnail_url && !safeUrl(record.thumbnail_url))) return showToast('تحقق من روابط الفيديو والصورة.', 'error');
  const button = $('button[type="submit"]', form); setBusy(button, true);
  try {
    const { error } = await state.supabase.from('videos').insert(record);
    if (error) throw error;
    await loadPublicData(); showToast('تمت إضافة المقطع.');
  } catch (error) { showToast(prettyError(error), 'error'); }
  finally { setBusy(button, false); }
}

async function onProgramSubmit(form) {
  const data = new FormData(form);
  const id = String(data.get('id') || '');
  const record = {
    title: String(data.get('title') || '').trim(),
    image_url: String(data.get('image_url') || '').trim(),
    description: String(data.get('description') || '').trim(),
  };
  const downloadUrl = safeUrl(String(data.get('download_url') || ''));
  if ((record.image_url && !safeUrl(record.image_url)) || !downloadUrl) return showToast('تحقق من روابط صورة البرنامج والتنزيل.', 'error');
  const button = $('button[type="submit"]', form); setBusy(button, true);
  try {
    let programId = id;
    if (id) {
      const { error } = await state.supabase.from('programs').update(record).eq('id', id);
      if (error) throw error;
    } else {
      const { data: created, error } = await state.supabase.from('programs').insert(record).select('id').single();
      if (error) throw error;
      programId = created.id;
    }
    const { error: downloadError } = await state.supabase.from('program_downloads').upsert(
      { program_id: programId, download_url: downloadUrl, updated_at: new Date().toISOString() }, { onConflict: 'program_id' });
    if (downloadError) throw downloadError;
    state.editProgramId = '';
    await loadPublicData(); showToast(id ? 'تم تحديث البرنامج.' : 'تمت إضافة البرنامج.');
  } catch (error) { showToast(prettyError(error), 'error'); }
  finally { setBusy(button, false); }
}

async function onNewsSubmit(form) {
  const data = new FormData(form);
  const image = String(data.get('image_url') || '').trim();
  if (image && !safeUrl(image)) return showToast('رابط صورة الخبر غير صالح.', 'error');
  const button = $('button[type="submit"]', form); setBusy(button, true);
  try {
    const { error } = await state.supabase.from('news').insert({
      title: String(data.get('title') || '').trim(), body: String(data.get('body') || '').trim(), image_url: image,
    });
    if (error) throw error;
    await loadPublicData(); showToast('تم نشر الخبر.');
  } catch (error) { showToast(prettyError(error), 'error'); }
  finally { setBusy(button, false); }
}

async function deleteItem(table, id) {
  if (!canManageContent() || !askConfirm('هل تريد حذف هذا العنصر؟ لا يمكن التراجع عن ذلك.')) return;
  const { error } = await state.supabase.from(table).delete().eq('id', id);
  if (error) return showToast(prettyError(error), 'error');
  await loadPublicData();
  if (state.devOpen) renderDeveloper();
  showToast('تم الحذف.');
}

async function deleteProgram(id) {
  if (!canManageContent() || !askConfirm('هل تريد حذف هذا البرنامج ورابط تنزيله؟')) return;
  const { error } = await state.supabase.from('programs').delete().eq('id', id);
  if (error) return showToast(prettyError(error), 'error');
  await loadPublicData(); renderDeveloper(); showToast('تم حذف البرنامج.');
}

async function onUserSubmit(form) {
  const data = new FormData(form);
  const id = String(data.get('id') || '');
  const roles = data.getAll('roles').map(String);
  if (!roles.length) return showToast('اختر رتبة واحدة على الأقل.', 'error');
  const sections = data.getAll('blocked_sections').map(String);
  const button = $('button[type="submit"]', form); setBusy(button, true);
  try {
    const { error } = await state.supabase.rpc('admin_update_user', {
      target_user: id, is_banned: Boolean(data.get('banned')), restricted_sections: sections, assigned_roles: roles,
    });
    if (error) throw error;
    closeModal();
    await refreshUsers();
    showToast('تم حفظ صلاحيات المستخدم.');
  } catch (error) { showToast(prettyError(error), 'error'); }
  finally { setBusy(button, false); }
}

async function onRoleSubmit(form) {
  const data = new FormData(form);
  const capabilities = {};
  ['dashboard_view', 'manage_content', 'manage_users'].forEach((key) => { capabilities[key] = Boolean(data.get(key)); });
  const button = $('button[type="submit"]', form); setBusy(button, true);
  try {
    const { error } = await state.supabase.rpc('admin_create_role', {
      requested_key: String(data.get('role_key') || '').trim(),
      requested_label: String(data.get('label') || '').trim(),
      requested_description: String(data.get('description') || '').trim(),
      requested_capabilities: capabilities,
    });
    if (error) throw error;
    await loadPublicData();
    state.devTab = 'roles'; renderDeveloper(); showToast('تم إنشاء الرتبة.');
  } catch (error) { showToast(prettyError(error), 'error'); }
  finally { setBusy(button, false); }
}

async function deleteRole(roleKey) {
  if (!askConfirm('حذف الرتبة؟ ستزال من جميع الحسابات التي تملكها.')) return;
  const { error } = await state.supabase.rpc('admin_delete_role', { requested_key: roleKey });
  if (error) return showToast(prettyError(error), 'error');
  await loadPublicData(); state.devTab = 'roles'; renderDeveloper(); showToast('تم حذف الرتبة.');
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.matches('[data-auth]')) {
    event.preventDefault();
    if (!state.supabase) return showToast('أكمل إعداد Supabase في ملف .env قبل تسجيل الدخول أو إنشاء حساب.', 'error');
    authModal(target.dataset.auth);
    return;
  }
  if (target.matches('[data-route]')) {
    state.route = target.dataset.route;
    $('#mobile-menu').classList.remove('is-open');
    renderPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const action = target.dataset.action;
  if (!action) return;
  if (action === 'switch-auth') return authModal(target.dataset.mode);
  if (action === 'close-modal') return closeModal();
  if (action === 'open-developer') return openDeveloper();
  if (action === 'logout') {
    await state.supabase.auth.signOut();
    state.devOpen = false; closeModal(); await syncAuth(null); showToast('تم تسجيل الخروج.'); return;
  }
  if (action === 'program-detail') return openProgram(target.dataset.id);
  if (action === 'dev-tab') { state.devTab = target.dataset.tab; return renderDeveloper(); }
  if (action === 'content-tab') { state.contentTab = target.dataset.tab; return renderDeveloper(); }
  if (action === 'pause-stream') return updateStreamStatus(state.stream?.status === 'live' ? 'paused' : 'live');
  if (action === 'stop-stream') {
    if (askConfirm('إيقاف البث نهائياً؟')) return updateStreamStatus('offline');
    return;
  }
  if (action === 'delete-item') return deleteItem(target.dataset.table, target.dataset.id);
  if (action === 'delete-program') return deleteProgram(target.dataset.id);
  if (action === 'edit-program') {
    const program = state.programs.find((item) => item.id === target.dataset.id);
    if (!program) return;
    const { data } = await state.supabase.from('program_downloads').select('download_url').eq('program_id', program.id).maybeSingle();
    state.editProgramId = program.id;
    state.devOpen = true; state.devTab = 'content'; state.contentTab = 'programs';
    renderDeveloper();
    const form = $('#program-form', modalRoot);
    if (form) form.outerHTML = programForm({ ...program, download_url: data?.download_url || '' });
    return;
  }
  if (action === 'cancel-edit-program') { state.editProgramId = ''; return renderDeveloper(); }
  if (action === 'refresh-users') {
    try { await refreshUsers(); } catch (error) { showToast(prettyError(error), 'error'); }
    return;
  }
  if (action === 'edit-user') {
    const user = state.profiles.find((item) => item.id === target.dataset.id);
    if (user) userEditorModal(user);
    return;
  }
  if (action === 'delete-role') return deleteRole(target.dataset.id);
  if (action === 'backdrop-close' && event.target === target) return closeModal();
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.id) return;
  event.preventDefault();
  if (form.id === 'auth-form') return onAuthSubmit(form);
  if (form.id === 'stream-form') return onStreamSubmit(form);
  if (form.id === 'video-form') return onVideoSubmit(form);
  if (form.id === 'program-form') return onProgramSubmit(form);
  if (form.id === 'news-form') return onNewsSubmit(form);
  if (form.id === 'user-form') return onUserSubmit(form);
  if (form.id === 'role-form') return onRoleSubmit(form);
});

$('#developer-button').addEventListener('click', openDeveloper);
$('#mobile-menu').addEventListener('click', () => {
  const menu = $('#mobile-menu');
  const open = menu.classList.toggle('is-open');
  menu.setAttribute('aria-expanded', String(open));
  $('.main-nav').classList.toggle('is-open', open);
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
  if (event.key === 'Tab' && modalRoot.firstElementChild) {
    const dialog = $('.modal', modalRoot);
    const focusable = $$('button, input, textarea, select, a[href]', dialog).filter((item) => !item.disabled);
    if (!focusable.length) return;
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  }
});

async function start() {
  try {
    state.supabase = await getSupabase();
    const { data: { session } } = await state.supabase.auth.getSession();
    await loadPublicData();
    await syncAuth(session);
    window.setInterval(() => { void checkLatestNotification(); }, 30000);
    state.supabase.auth.onAuthStateChange((_event, newSession) => {
      window.setTimeout(() => { void syncAuth(newSession); }, 0);
    });
  } catch (error) {
    state.configError = error.message || 'تعذر الاتصال بقاعدة البيانات.';
    renderPage();
  }
}
start();

