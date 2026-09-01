/**
 * The app's chart primitives.
 *
 * Hand-rolled inline SVG, on purpose. The alternative was a charting library,
 * and every one of them arrives with its own opinions about type scale, tick
 * density, tooltip chrome and colour — opinions this app already has, expressed
 * as design tokens. Three small components that read `var(--chart-N)` and the
 * surface tokens are theme-aware for free, weigh nothing in the bundle, and do
 * not have to be fought into looking like the rest of the console.
 *
 * What is here is deliberately narrow: a line/area trend, stacked day columns,
 * and the shared frame that gives both a title, a legend, an accessible table
 * and an honest empty state. Anything more elaborate than that is a sign the
 * screen is asking a question a chart is not the right answer to.
 */
export { LineTrend, type LineSeries, type LineTrendProps } from './LineTrend';
export { StackedBars, type BarCategory, type StackedBarsProps } from './StackedBars';
export {
  ChartFrame,
  ChartLegend,
  ChartDataTable,
  ChartTooltip,
  useChartWidth,
  useChartCursor,
  compactNumber,
  fullNumber,
} from './ChartFrame';
export { CHART_SERIES_VARS, MAX_SERIES, OTHER_SERIES_VAR, seriesVar } from './palette';
export { zeroFillDays, zeroFillNumeric, dayRange, utcDayKey, type DayRow } from './zeroFill';
