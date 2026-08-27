let mode = 'login'; // or 'signup'

const form = document.getElementById('authForm');
const errorMsg = document.getElementById('errorMsg');
const formTitle = document.getElementById('formTitle');
const submitBtn = document.getElementById('submitBtn');
const toggleRow = document.getElementById('toggleRow');
const toggleLink = document.getElementById('toggleLink');

function renderMode() {
  if (mode === 'login') {
    formTitle.textContent = 'Вход';
    submitBtn.textContent = 'Войти';
    toggleRow.innerHTML = 'Нет аккаунта? <a id="toggleLink">Зарегистрироваться</a>';
  } else {
    formTitle.textContent = 'Регистрация';
    submitBtn.textContent = 'Создать аккаунт';
    toggleRow.innerHTML = 'Уже есть аккаунт? <a id="toggleLink">Войти</a>';
  }
  document.getElementById('toggleLink').addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    errorMsg.style.display = 'none';
    renderMode();
  });
}
renderMode();

// If already logged in, skip straight to dashboard.
fetch('/api/auth/me').then((r) => r.json()).then((data) => {
  if (data.authenticated) window.location.href = '/dashboard';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.style.display = 'none';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  submitBtn.disabled = true;
  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    window.location.href = '/dashboard';
  } catch (err) {
    errorMsg.textContent = err.message;
    errorMsg.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
  }
});
