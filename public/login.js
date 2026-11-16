'use strict';

(() => {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

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
