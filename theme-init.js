/* 主题初始化：在 CSS 绘制前恢复用户主题偏好（外置脚本以满足 CSP script-src 'self'） */
try { document.documentElement.dataset.theme = localStorage.getItem('ct-theme') || 'dark'; } catch (e) { document.documentElement.dataset.theme = 'dark'; }
