const within = (operation) => Promise.race([
  Promise.resolve(operation).catch(() => null),
  new Promise((resolve) => setTimeout(() => resolve(null), 400)),
]);

(async () => {
  const theme = await within(window.magpie?.ready);
  const query = new URLSearchParams({ v: String(Date.now()) });
  if (typeof theme?.dark === 'boolean') query.set('theme', theme.dark ? 'dark' : 'light');
  location.replace(`http://127.0.0.1:3572/?${query}`);
})().catch(() => {
  document.getElementById('status').textContent = '无法打开宠物对战，请重新打开此侧栏页面。';
});
