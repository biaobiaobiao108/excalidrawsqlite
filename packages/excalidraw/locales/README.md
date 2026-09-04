## How to contribute

Please do not contribute changes directly to these files, as we manage them with Crowdin. Instead:

- to request a new translation, [open an issue](https://github.com/excalidraw/excalidraw/issues/new/choose).
- to update existing translations, [edit them on Crowdin](https://crowdin.com/translate/excalidraw/10) and we should have them included in the app soon!

## Completion of translation

[percentages.json](./percentages.json) holds a percentage of completion for each language. Regenerate it with `bun scripts/build-locales-coverage.js` when translations change.

We only make a language available on the app if it exceeds a certain threshold of completion.
