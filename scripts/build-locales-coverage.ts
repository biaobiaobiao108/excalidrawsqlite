const localeDirectory = `${import.meta.dir}/../packages/excalidraw/locales`;
const files: string[] = [];

for await (const file of new Bun.Glob("*.json").scan({
  cwd: localeDirectory,
  onlyFiles: true,
})) {
  files.push(file);
}

const flatten = (
  object: Record<string, any> = {},
  result: Record<string, any> = {},
  extraKey = "",
) => {
  for (const key in object) {
    if (typeof object[key] !== "object" || object[key] === null) {
      result[extraKey + key] = object[key];
    } else {
      flatten(object[key], result, `${extraKey}${key}.`);
    }
  }
  return result;
};

const locales = files.filter(
  (file) => file !== "percentages.json",
);

const percentages: Record<string, number> = {};

for (const currentLocale of locales) {
  const data = flatten(
    await Bun.file(`${localeDirectory}/${currentLocale}`).json(),
  );
  const allKeys = Object.keys(data);
  const translatedKeys = allKeys.filter((item) => data[item] !== "");
  const percentage = Math.floor((100 * translatedKeys.length) / allKeys.length);
  percentages[currentLocale.replace(".json", "")] = percentage;
}

await Bun.write(
  `${localeDirectory}/percentages.json`,
  `${JSON.stringify(percentages, null, 2)}\n`,
);
