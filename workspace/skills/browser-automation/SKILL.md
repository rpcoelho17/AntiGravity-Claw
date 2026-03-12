---
name: browser-automation
description: (PRIMARY) Use for LinkedIn, social media, and visible Chrome tasks. Opens a REAL window on the desktop.
read_when:
  - User asks for LinkedIn, social media, or login-protected sites
  - User wants to "see" the browser window
---

## CRITICAL: Windows Execution Syntax
You are on Windows. You MUST use backslashes (`\`) and drive letters. Do NOT use forward slashes for `cd`.

```bash
cd /d "D:\FILES\Code\AntiGravityClaw\workspace\skills\browser-automation" && set NODE_OPTIONS=--no-deprecation && npx tsx src/cli.ts navigate https://www.linkedin.com
```

### Supported Commands:
- `navigate <url>`: Opens a visible Chrome window and navigates.
- `act "<action>"`: Clicks, types, etc.
- `extract "<instruction>"`: Scrapes data.
- `screenshot`: Takes a screenshot.
- `close`: Closes the browser.

### Rules:
1. **No POSIX paths**: Never use `/d/FILES/...`. Use `D:\FILES\...`.
2. **Persistence**: The browser stays open. Do NOT close it unless the user asks.
3. **Logins**: Uses the user's Chrome profile. Log in once manually if needed.
