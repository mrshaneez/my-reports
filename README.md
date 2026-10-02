# އިސްތިއުނާފު ރިޕޯޓު (Appeal Report)

A Dhivehi app for writing appeal case reports. Enter the case details, how the lower court decided, the appeal points, and how each party wants the case concluded, and the formatted report builds alongside. Copy it straight into Word.

## Files

- `index.html` – the whole app (form, live report, admin panel, phonetic Thaana keyboard)
- `fonts/Faruma.ttf` – the Dhivehi font
- `api/settings.js` – saves the admin settings to Vercel Blob

## Settings on Vercel

The admin panel's settings (form fields, report sections, header and signature, standard paragraphs) are saved to a Vercel Blob store, so they are the same on every device. Two environment variables are needed:

- `BLOB_READ_WRITE_TOKEN` – added automatically when a Blob store is connected to the project
- `ADMIN_PASSWORD` – the password the admin panel asks for

Case drafts are kept only in the browser where they are written.

## Findings (ފާހަގަކުރެވުނު ކަންކަން)

`api/findings.js` writes the findings section with Claude. Claude researches with web search, so every reference link is a page it actually retrieved. The author's previous judgments, uploaded in the admin panel (`api/judgments.js`), are given to Claude as examples of the author's style.

Extra environment variables:

- `ANTHROPIC_API_KEY` – required, from console.anthropic.com
- `ANTHROPIC_MODEL` – optional, defaults to `claude-opus-5-5`
- `STYLE_CHARS` – optional, how many characters of previous judgments to include (default 120000)
- `MAX_SEARCHES` – optional, web searches per analysis (default 10)
