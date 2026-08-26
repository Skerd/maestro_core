# Email previews

Renders every transactional email this server sends to a PNG, so template and copy
changes can be reviewed without wiring up SMTP or triggering real events.

```bash
# from maestro/
npm run preview:emails -- --list                          # what can be rendered
npm run preview:emails -- --help                          # every option

npm run preview:emails                                    # every email, every locale
npm run preview:emails -- --modules=core,propertyManagement
npm run preview:emails -- --languages=de-CH,fr-FR
npm run preview:emails -- --modules=eCommerce --languages=it-IT
npm run preview:emails -- --only=reservation              # substring match on the case name
npm run preview:emails -- --width=400                     # narrow viewport (mobile rules)
```

`--modules` takes `core`, `propertyManagement`, `eCommerce` (or `all`); `--languages`
takes any supported locale tag (or `all`). Both default to everything, and an
unrecognised value fails fast with the list of valid ones.

Images land in `maestro/_temp/emails/`, grouped as `<module>/<locale>/<case>.png`:

```
_temp/emails/
├── index.json                        every image with the subject line it was sent under
├── core/
│   ├── en-US/activateAccount.png
│   └── de-CH/activateAccount.png
├── propertyManagement/
│   └── fr-FR/reservation-created.png
└── eCommerce/
    └── it-IT/order-shipped.png
```

`_temp/` is already git-ignored, so previews never land in a commit. Pass `--html` to
keep the rendered HTML next to each image, or `--out=<dir>` to write somewhere else.

## How it works

The script calls the **real** notifiers — `sendSignUpMail`, `sendReservationClientMail`,
`sendProductOrderClientMail`, and so on — and swaps `sendMail` for a capture function.
What gets screenshotted is exactly the HTML that would have gone to the SMTP server,
so there is no second copy of the placeholder wiring to drift out of sync with
production. Two things are stubbed: mail delivery, and the GridFS contract lookup
(`tryLoadReservationContractForEmail`), which stands in a placeholder PDF so the
"contract attached" note renders on the kinds that carry one.

Inline images are attached by CID, which a browser cannot resolve, so each `cid:`
reference is rewritten to a data URI before screenshotting.

Sample payloads live in `emailPreviewCases.ts`. They deliberately populate every
optional field a template can show — a preview is most useful when it exposes the
longest layout a recipient could get. **Add a case there whenever you add an email
kind**, otherwise it silently drops out of the sweep.

## Requirements

- **Chrome or Chromium** for screenshots. The script checks `--chrome=<path>`, then
  `$CHROME_BIN`, then the usual macOS/Linux install locations.
- **Pillow** (`python3 -m pip install pillow`) to crop the dead space below each email.
  Without it the images render fine, just with a tall blank tail.

A full sweep is 185 images and takes roughly six minutes — one Chrome process per
image. Narrow it with `--modules` / `--languages` / `--only` while iterating.

## Reading the output

Locale folders are the *resolved* email locale tag, not the requested code. A module
without a translation for a language falls back to `en-US`, so
`eCommerce/it-IT/order-placed.png` currently shows English copy — eCommerce only ships
`en-US` and `sq-AL`. That fallback is deliberate, and the sweep makes it visible.
