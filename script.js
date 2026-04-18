// ===== DATA =====
const apiBase = (typeof window !== "undefined" && window.JD_API_BASE ? String(window.JD_API_BASE) : "")
  .trim()
  .replace(/\/+$/, "");
const apiUrl = (path) => (apiBase ? `${apiBase}${path}` : path);

if (!apiBase) {
  console.warn("JD_API_BASE is empty. API calls will use same-origin /api/* and will fail on GitHub Pages.");
}

let imgs = [
  {src:'PNG/salon-1.jpg', cap:'صالون رقم 1 - تصميم عصري أنيق'},
  {src:'PNG/salon-2.jpg', cap:'صالون رقم 2 - أناقة وفخامة'},
  {src:'PNG/salon-3.jpg', cap:'صالون رقم 3 - تصميم داخلي راقٍ'},
  {src:'PNG/salon-4.jpg', cap:'صالون رقم 4 - فخامة وأصالة'},
];
let captchaEnabled = false;
let turnstileWidgetId = null;
const waDefaultPhone = '212690875647';
const callDefaultPhone = '0690875647';
let waCurrentPhone = waDefaultPhone;
let callCurrentPhone = callDefaultPhone;
let waOpenLock = false;
const waMessages = {
  availability: 'مرحباً، أريد الاستفسار عن المنتجات والتصاميم المتوفرة حالياً.',
  quote: 'مرحباً، أريد عرض سعر لصالون أو ديكور مع تفاصيل التوصيل والتركيب.',
  consulting: 'مرحباً، أحتاج استشارة سريعة لاختيار التصميم المناسب لمساحتي وميزانيتي.'
};

async function hydrateMediaFromApi() {
  try {
    const fallbackImgs = Array.isArray(imgs) ? imgs.slice(0) : [];
    const res = await fetch(apiUrl('/api/v1/products?limit=8'));
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items.slice(0, 4) : [];
    if (!items.length) return;

    const normalizeImageUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^https?:\/\//i.test(raw)) return raw;
      // allow relative URLs coming from the API (e.g. PNG/foo.jpg)
      try {
        return new URL(raw.replace(/^\/+/, ''), document.baseURI).toString();
      } catch {
        return raw;
      }
    };

    const apiImgs = items.map((p) => ({
      src: normalizeImageUrl(p.main_image_url) || '',
      cap: p.name || 'منتج'
    }));

    // Avoid showing a single repeated image when the API only has 1–2 products.
    // Fill the remaining slots with the built-in fallback images.
    const nextImgs = apiImgs.filter((x) => x.src);
    for (let i = 0; nextImgs.length < 4 && i < fallbackImgs.length; i++) {
      const candidate = fallbackImgs[i];
      if (!candidate?.src) continue;
      const already = nextImgs.some((x) => x.src === candidate.src);
      if (!already) nextImgs.push(candidate);
    }
    if (nextImgs.length >= 2) imgs = nextImgs;

    const slides = document.querySelectorAll('.hero .slide');
    slides.forEach((slide, i) => {
      const img = imgs[i % imgs.length];
      if (img?.src) slide.style.backgroundImage = `url('${img.src}')`;
    });

    const galleryImgs = document.querySelectorAll('.gallery-grid .gitem img');
    galleryImgs.forEach((imgEl, i) => {
      const item = imgs[i % imgs.length];
      imgEl.src = item.src;
      imgEl.alt = item.cap;
    });

    const aboutImg = document.querySelector('.about-img');
    if (aboutImg && imgs[1]?.src) {
      aboutImg.src = imgs[1].src;
      aboutImg.alt = imgs[1].cap;
    }
  } catch (err) {
    console.error('hydrateMediaFromApi failed', err);
  }
}

function parseWaPhone(url) {
  const match = String(url || '').match(/wa\.me\/(\d+)/i);
  return match ? match[1] : waDefaultPhone;
}

function parseTelPhone(url) {
  const raw = String(url || '').replace(/^tel:/i, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return callDefaultPhone;
  // keep local Moroccan format for tel links
  if (digits.startsWith('212') && digits.length === 12) return '0' + digits.slice(3);
  if (digits.length === 9 && /^[567]/.test(digits)) return '0' + digits;
  return digits;
}

function openWhatsApp(phone, message) {
  if (waOpenLock) return;
  waOpenLock = true;
  setTimeout(() => { waOpenLock = false; }, 800);
  const target = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(target, '_blank', 'noopener,noreferrer');
}

function setWaModal(open) {
  const modal = document.getElementById('waModalBg');
  if (!modal) return;
  modal.classList.toggle('open', open);
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.style.overflow = open ? 'hidden' : '';
}

function openContactChoices(params) {
  if (params?.waPhone) waCurrentPhone = params.waPhone;
  if (params?.callPhone) callCurrentPhone = params.callPhone;
  setWaModal(true);
}

function initContactLinks() {
  // WhatsApp links -> open choices (do NOT open WhatsApp directly on first click)
  document.querySelectorAll('a[href*="wa.me/"]').forEach((link) => {
    const originalHref = link.getAttribute('href') || '';
    const phone = parseWaPhone(originalHref);
    link.setAttribute('data-wa-phone', phone);
    link.setAttribute('href', `https://wa.me/${phone}`);
    link.setAttribute('rel', 'noopener noreferrer');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContactChoices({ waPhone: link.getAttribute('data-wa-phone') || phone });
    });
  });

  // Phone links -> open the SAME choices modal (call is an option inside the list)
  document.querySelectorAll('a[href^="tel:"]').forEach((link) => {
    const originalHref = link.getAttribute('href') || '';
    const phone = parseTelPhone(originalHref);
    link.setAttribute('data-call-phone', phone);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContactChoices({ callPhone: link.getAttribute('data-call-phone') || phone });
    });
  });
}

function bindContactModalHandlersOnce() {
  if (typeof window !== 'undefined' && window.__JD_CONTACT_BOUND) return;
  if (typeof window !== 'undefined') window.__JD_CONTACT_BOUND = true;

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const optionBtn = target.closest('.wa-option');
    if (optionBtn) {
      const key = optionBtn.getAttribute('data-wa-option') || '';
      setWaModal(false);

      if (key === 'call') {
        const tel = `tel:${callCurrentPhone || callDefaultPhone}`;
        window.location.href = tel;
        return;
      }

      const selected = waMessages[key] || waMessages.availability;
      openWhatsApp(waCurrentPhone || waDefaultPhone, selected);
      return;
    }

    if (target.id === 'waModalBg' || target.id === 'waModalClose') {
      setWaModal(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setWaModal(false);
  });
}

async function loadPublicConfig() {
  try {
    const res = await fetch(apiUrl('/api/v1/public-config'));
    if (!res.ok) return;
    const config = await res.json();
    captchaEnabled = Boolean(config?.captcha?.enabled);
    const siteKey = config?.captcha?.siteKey || '';
    const wrap = document.getElementById('captchaWrap');
    const widget = document.getElementById('captchaWidget');

    if (!captchaEnabled || !siteKey || !wrap || !widget) {
      return;
    }

    wrap.classList.remove('hidden-captcha');
    if (window.turnstile && turnstileWidgetId === null) {
      turnstileWidgetId = window.turnstile.render('#captchaWidget', {
        sitekey: siteKey,
        theme: 'light',
        language: 'ar'
      });
    }
  } catch (err) {
    console.error('Failed to load public config', err);
  }
}

// ===== NAVBAR =====
const navbar = document.getElementById('navbar');
const btt = document.getElementById('btt');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 50);
  btt.classList.toggle('show', window.scrollY > 400);
  checkAOS();
  updateActiveNav();
});

// ===== HAMBURGER =====
const ham = document.getElementById('hamburger');
const nav = document.getElementById('navLinks');
ham.addEventListener('click', () => { nav.classList.toggle('open'); ham.classList.toggle('x'); });
document.querySelectorAll('.nav-link').forEach(l => l.addEventListener('click', () => { nav.classList.remove('open'); ham.classList.remove('x'); }));
document.addEventListener('click', e => { if (!navbar.contains(e.target)) { nav.classList.remove('open'); ham.classList.remove('x'); } });

// Add hamburger animation styles
const s = document.createElement('style');
s.textContent = `.hamburger.x span:nth-child(1){transform:translateY(7px) rotate(45deg)}.hamburger.x span:nth-child(2){opacity:0}.hamburger.x span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}`;
document.head.appendChild(s);

// ===== ACTIVE NAV =====
function updateActiveNav() {
  const scrollY = window.pageYOffset;
  document.querySelectorAll('section[id]').forEach(sec => {
    const top = sec.offsetTop - 100;
    if (scrollY >= top && scrollY < top + sec.offsetHeight) {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      const a = document.querySelector(`.nav-link[href="#${sec.id}"]`);
      if (a) a.classList.add('active');
    }
  });
}

// ===== HERO SLIDER =====
const slides = document.querySelectorAll('.slide');
const dotsEl = document.getElementById('slideDots');
let cur = 0;
slides.forEach((_, i) => {
  const d = document.createElement('button');
  d.className = 'sdot' + (i === 0 ? ' active' : '');
  d.onclick = () => goSlide(i);
  dotsEl.appendChild(d);
});
function goSlide(i) {
  slides[cur].classList.remove('active');
  dotsEl.children[cur].classList.remove('active');
  cur = i;
  slides[cur].classList.add('active');
  dotsEl.children[cur].classList.add('active');
}
setInterval(() => goSlide((cur + 1) % slides.length), 5000);

// ===== LIGHTBOX =====
let lbIdx = 0;
function openLB(i) {
  lbIdx = i; updateLB();
  document.getElementById('lb').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLB() {
  document.getElementById('lb').classList.remove('open');
  document.body.style.overflow = '';
}
function moveLB(d) { lbIdx = (lbIdx + d + imgs.length) % imgs.length; updateLB(); }
function updateLB() {
  document.getElementById('lbImg').src = imgs[lbIdx].src;
  document.getElementById('lbCap').textContent = imgs[lbIdx].cap;
}
document.addEventListener('keydown', e => {
  if (!document.getElementById('lb').classList.contains('open')) return;
  if (e.key === 'Escape') closeLB();
  if (e.key === 'ArrowRight') moveLB(-1);
  if (e.key === 'ArrowLeft') moveLB(1);
});

// ===== TESTIMONIALS =====
const tcards = document.querySelectorAll('.tcard');
const tdots = document.getElementById('tdots');
let tCur = 0;
tcards.forEach((_, i) => {
  const d = document.createElement('button');
  d.className = 'tdot' + (i === 0 ? ' active' : '');
  d.onclick = () => goT(i);
  tdots.appendChild(d);
});
function goT(i) {
  tcards[tCur].classList.remove('active');
  tdots.children[tCur].classList.remove('active');
  tCur = i;
  tcards[tCur].classList.add('active');
  tdots.children[tCur].classList.add('active');
}
setInterval(() => goT((tCur + 1) % tcards.length), 5000);

// ===== ORDER FORM =====
function setModalContent(title, message) {
  const titleEl = document.getElementById('modalTitle');
  const msgEl = document.getElementById('modalMessage');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
}

let successModal = null;
let successModalCloseBtn = null;

function toggleSuccessModal(open) {
  if (!successModal) return;
  successModal.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

function closeSuccessModal() {
  toggleSuccessModal(false);
}

function closeAndResumeShopping() {
  closeSuccessModal();
  const gallery = document.getElementById('gallery');
  if (gallery) {
    const top = gallery.getBoundingClientRect().top + window.pageYOffset - 80;
    window.scrollTo({ top: top < 0 ? 0 : top, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

if (successModal) {
  successModal.addEventListener('click', (e) => {
    if (e.target === successModal) closeSuccessModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSuccessModal();
});

function bindSuccessModal() {
  successModal = document.getElementById('modalBg');
  successModalCloseBtn = document.getElementById('modalCloseBtn');

  if (successModal) {
    successModal.addEventListener('click', (e) => {
      if (e.target === successModal) closeSuccessModal();
    });
  }

  if (successModalCloseBtn) {
    successModalCloseBtn.addEventListener('click', closeAndResumeShopping);
    successModalCloseBtn.setAttribute('type', 'button');
  }
}

// Delegate close behaviour to any element that declares data-close-modal
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-modal]');
  if (!closeBtn) return;
  const targetId = closeBtn.getAttribute('data-close-modal');
  if (targetId === 'modalBg') {
    closeAndResumeShopping();
  } else {
    const target = document.getElementById(targetId);
    if (target) target.classList.remove('open');
  }
});

// ensure bindings happen after DOM is ready (defensive against cached/async scripts)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindSuccessModal);
} else {
  bindSuccessModal();
}

async function sendOrder(e) {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  let captchaToken = '';
  const maxDetailsWords = 120;
  const maxNameWords = 10;
  const hasDangerous = (text) => /<|>|`|script|javascript:|data:/i.test(text);
  const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;

  if (captchaEnabled) {
    if (!window.turnstile || turnstileWidgetId === null) {
      setModalContent('التحقق الأمني غير جاهز', 'يرجى إعادة تحميل الصفحة والمحاولة مجددًا.');
      document.getElementById('modalBg').classList.add('open');
      return;
    }
    captchaToken = window.turnstile.getResponse(turnstileWidgetId);
    if (!captchaToken) {
      setModalContent('تحقق أمني مطلوب', 'يرجى إكمال التحقق الأمني قبل إرسال الطلب.');
      document.getElementById('modalBg').classList.add('open');
      return;
    }
  }

  const payload = {
    fullName: document.getElementById('fname').value.trim(),
    phone: document.getElementById('fphone').value.trim(),
    city: document.getElementById('fcity').value.trim(),
    productType: document.getElementById('fprod').value,
    budgetRange: document.getElementById('fbudget').value,
    details: document.getElementById('fdetails').value.trim(),
    source: 'website',
    captchaToken
  };

  // Phone normalization/validation (Morocco)
  const normalizePhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    let d = digits;
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('212') && d.length === 12) d = '0' + d.slice(3);
    if (d.length === 9 && /^[567]/.test(d)) d = '0' + d;
    return d;
  };
  payload.phone = normalizePhone(payload.phone);
  if (!/^0[567]\d{8}$/.test(payload.phone)) {
    setModalContent('رقم الهاتف غير صحيح', 'أدخل رقم هاتف مغربي من 10 أرقام يبدأ بـ 05 أو 06 أو 07 (مثال: 0612345678).');
    document.getElementById('modalBg').classList.add('open');
    return;
  }

  // Frontend validation: word limits and basic payload hygiene
  if (countWords(payload.fullName) > maxNameWords) {
    setModalContent('الاسم طويل جدًا', `الرجاء اختصار الاسم (بحد أقصى ${maxNameWords} كلمات).`);
    document.getElementById('modalBg').classList.add('open');
    return;
  }
  if (countWords(payload.details) > maxDetailsWords) {
    setModalContent('التفاصيل طويلة جدًا', `الرجاء تقليل التفاصيل إلى ${maxDetailsWords} كلمة كحد أقصى.`);
    document.getElementById('modalBg').classList.add('open');
    return;
  }
  const fieldsToCheck = [payload.fullName, payload.city, payload.details, payload.productType, payload.budgetRange];
  if (fieldsToCheck.some(hasDangerous)) {
    setModalContent('تنسيق غير مقبول', 'يُرجى عدم إدخال أكواد أو رموز خاصة قد تعطل النظام.');
    document.getElementById('modalBg').classList.add('open');
    return;
  }

  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...';
  btn.disabled = true;

  try {
    const res = await fetch(apiUrl('/api/v1/leads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const code = (data && (data.error || data.code)) ? String(data.error || data.code) : '';
      const message = data && data.message ? String(data.message) : '';

      const friendly =
        code === 'INVALID_CAPTCHA' ? 'التحقق الأمني غير صحيح. أعد المحاولة.' :
        code === 'INVALID_PHONE' ? 'رقم الهاتف غير صحيح. تأكد من الرقم.' :
        code === 'VALIDATION_ERROR' ? 'يرجى التحقق من الحقول المطلوبة.' :
        message ? message :
        `تعذر الحفظ (HTTP ${res.status}).`;

      throw new Error(friendly);
    }

    setModalContent('تم إرسال طلبك بنجاح!', 'تم حفظ الطلب وسيتواصل معكم فريقنا خلال 24 ساعة.');
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال الطلب';
    btn.disabled = false;
    document.getElementById('orderForm').reset();
    if (captchaEnabled && window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
    toggleSuccessModal(true);
  } catch (err) {
    console.error(err);
    const details = err && err.message ? String(err.message) : 'حدث خطأ أثناء الحفظ. حاول مرة أخرى أو تواصل معنا عبر الهاتف/واتساب.';
    setModalContent('تعذر إرسال الطلب', details);
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> إرسال الطلب';
    btn.disabled = false;
    if (captchaEnabled && window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
    toggleSuccessModal(true);
  }
}

// Bind submit handler without inline JS to satisfy CSP
const orderFormEl = document.getElementById('orderForm');
if (orderFormEl) {
  orderFormEl.addEventListener('submit', (e) => {
    e.preventDefault();
    sendOrder(e);
  });
}

// ===== AOS =====
function checkAOS() {
  document.querySelectorAll('[data-aos]').forEach(el => {
    if (el.getBoundingClientRect().top < window.innerHeight - 80) el.classList.add('aon');
  });
}
window.addEventListener('load', () => { checkAOS(); setTimeout(checkAOS, 300); });
checkAOS();
window.addEventListener('load', () => { void loadPublicConfig(); });
window.addEventListener('load', () => {
  bindContactModalHandlersOnce();
  initContactLinks();
});
window.addEventListener('load', () => { void hydrateMediaFromApi(); });

// ===== SMOOTH SCROLL =====
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', function(e) {
    const t = document.querySelector(this.getAttribute('href'));
    if (t) { e.preventDefault(); window.scrollTo({ top: t.getBoundingClientRect().top + window.pageYOffset - 80, behavior: 'smooth' }); }
  });
});

console.log('✨ جديد بوجدور - Loaded Successfully');
