/** The page shown in the browser when `harness login`'s loopback SSO callback succeeds. */
export function renderLoginSuccessHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Harness</title>
<style>
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #181818;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    color: #f5f5f5;
  }
  .card {
    width: 340px;
    padding: 32px 28px;
    background: #1e1e1e;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    text-align: center;
  }
  .check {
    width: 40px;
    height: 40px;
    margin: 0 auto 16px;
    border-radius: 50%;
    background: #3fb950;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
  }
  p {
    margin: 0;
    font-size: 13px;
    color: #a8a8a2;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="check">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M4 10.5L8 14.5L16 6" stroke="#181818" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h1>Harness login complete</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`
}
