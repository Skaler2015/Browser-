# TezBrowser 🛡⚡

एक फ़ास्ट, ऐड-फ़्री डेस्कटॉप वेब ब्राउज़र (Windows / macOS / Linux) — Electron (Chromium इंजन) पर बना हुआ।

A fast, ad-free desktop web browser built on Electron (Chromium engine) with a built-in ad & tracker blocker.

## खासियतें (Features)

- 🚫 **बिल्ट-इन ऐड-ब्लॉकर** — Ghostery adblocker इंजन + EasyList/EasyPrivacy फ़िल्टर। ऐड और ट्रैकर नेटवर्क लेवल पर ही ब्लॉक हो जाते हैं।
- ⚡ **तेज़ ब्राउज़िंग** — ऐड/ट्रैकर की सैकड़ों रिक्वेस्ट ब्लॉक होने से पेज काफ़ी तेज़ लोड होते हैं और डेटा भी बचता है।
- 🗂 **मल्टी-टैब** — टैब खोलें/बंद करें (Ctrl+T / Ctrl+W), मिडिल-क्लिक से टैब बंद करें।
- 🔍 **स्मार्ट एड्रेस बार** — URL लिखें या सीधे सर्च करें (DuckDuckGo — प्राइवेसी-फ़्रेंडली सर्च)।
- 🛡 **ब्लॉक काउंटर** — हर टैब पर दिखता है कि कितने ऐड/ट्रैकर ब्लॉक हुए।
- 🚫 **पॉपअप ब्लॉक** — पॉपअप विंडो नई टैब में खुलती हैं, अलग विंडो में नहीं।
- 📴 **ऑफ़लाइन कैश** — फ़िल्टर लिस्ट एक बार डाउनलोड होकर कैश हो जाती है।

## चलाने का तरीका (How to run)

पहले [Node.js](https://nodejs.org) (v18+) इंस्टॉल करें, फिर:

```bash
npm install
npm start
```

## कीबोर्ड शॉर्टकट (Keyboard shortcuts)

| शॉर्टकट | काम |
|---|---|
| `Ctrl+T` | नया टैब |
| `Ctrl+W` | टैब बंद करें |
| `Ctrl+R` | पेज रीलोड |
| `Ctrl+L` | एड्रेस बार पर जाएँ |

## इंस्टॉलर बनाना (Optional: build an installer)

Windows `.exe` / macOS `.dmg` / Linux `.AppImage` बनाने के लिए:

```bash
npm install --save-dev electron-builder
npx electron-builder --win   # या --mac / --linux
```

## स्ट्रक्चर (Structure)

```
src/
  main.js        # मुख्य प्रोसेस: विंडो, टैब, ऐड-ब्लॉकर, नेविगेशन
  preload.js     # UI ↔ main प्रोसेस के बीच सुरक्षित ब्रिज
  ui/
    index.html   # ब्राउज़र का टूलबार UI (टैब बार + एड्रेस बार)
    renderer.js  # टूलबार का लॉजिक
    start.html   # नया-टैब स्टार्ट पेज
```
