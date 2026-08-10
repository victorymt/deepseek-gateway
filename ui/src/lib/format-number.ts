const numberFormatters = {
  en: new Intl.NumberFormat("en-US"),
  "zh-CN": new Intl.NumberFormat("zh-CN"),
}

export function formatNumber(
  value: number,
  locale: keyof typeof numberFormatters
) {
  return numberFormatters[locale].format(value)
}
