# כתוביות בעברית ל-Stremio

תוסף Stremio שמביא כתוביות בעברית לסרטים וסדרות.

## התקנה מקומית
```
npm install
npm start
```
אחר כך ב-Stremio הוסף תוסף עם הכתובת:
`http://127.0.0.1:7000/manifest.json`

## פריסה ל-Render (חינם)
1. העלה את הפרויקט ל-GitHub.
2. ב-render.com: New > Web Service > בחר את המאגר.
3. Build Command: `npm install` | Start Command: `npm start`
4. אחרי הפריסה, הוסף ב-Stremio את `https://<השם-שלך>.onrender.com/manifest.json`

## Termux (אנדרואיד)
```
pkg install nodejs git
git clone <כתובת-המאגר-שלך>
cd <התיקייה>
npm install && npm start
```
