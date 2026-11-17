'use strict';

(() => {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');
  const themeBtn = document.getElementById('theme-toggle-btn');
  const themeLabel = document.getElementById('theme-toggle-label');
  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');

  function applyTheme(theme) {
    const clean = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', clean);
    try {
      localStorage.setItem('lab_central_theme', clean);
    } catch {
      /* ignore */
    }
    if (themeLabel) {
      themeLabel.textContent = clean === 'dark' ? 'Mode Terang' : 'Mode Gelap';
    }
    if (sunIcon && moonIcon) {
      sunIcon.classList.toggle('hidden', clean !== 'dark');
      moonIcon.classList.toggle('hidden', clean === 'dark');
    }
  }

  // Inisialisasi status tombol tema
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  function resolveNextPath() {
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next') || '';
    const allowed = ['/dashboard', '/visits', '/laboratories', '/inventory', '/import-audit'];
    if (allowed.includes(next)) return next;
    return '/dashboard';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Memverifikasi kredensial...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.value.trim(),
          password: passwordInput.value,
        }),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok) {
        throw new Error((data && data.message) || `Gagal masuk (HTTP ${res.status})`);
      }

      window.location.replace(resolveNextPath());
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Masuk ke Konsol Pusat';
    }
  });
})();
