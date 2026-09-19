/* What each block in the formula editor does, in a line (the palette's
   tooltip) and, where a line is not enough, in a few paragraphs behind the
   "?" on the block itself. Pure data. */

// The key a block's help is filed under: "tag", "num", "neg", "out",
// "op:+" or "fn:avg".
export function helpKey(node) {
  if (node.type === "op") return `op:${node.op}`;
  if (node.type === "fn") return `fn:${node.name}`;
  return node.type;
}

const HOLES_SKIPPED = "Inputs without a value at a moment are left out, so a gap in one " +
  "tag does not blank the result; only when every input is missing is the result missing.";

export const BLOCK_HELP = {
  tag: {
    short: "A tag from the historian",
    long: [
      "Type the tag name, or TAG;MAP for another record map than the default.",
      "A tag that is a row in the table is read the way that row is - its Type, " +
        "Period and Step. A tag that is not on the plot is read quietly, without a " +
        "row, with the formula row's own Type and Period.",
      "A formula row can be used too, by its short name in the Description column.",
    ],
  },
  num: { short: "A fixed number" },
  out: { short: "What the formula row shows: wire the finished expression in here" },
  "op:+": { short: "Add - takes any number of inputs" },
  "op:-": { short: "Subtract the lower input from the upper" },
  "op:*": { short: "Multiply - takes any number of inputs" },
  "op:/": { short: "Divide the upper input by the lower" },
  "op:^": { short: "The upper input to the power of the lower" },
  neg: { short: "Change the sign" },
  "op:>": {
    short: "1 when the upper input is greater than the lower, else 0",
    long: [
      "Gives 1 while the comparison holds and 0 while it does not, and nothing " +
        "where either input is missing.",
      "Wired into a total, it counts hours: total([FI-104] > 5, day) is how many " +
        "hours per day the flow was above 5.",
    ],
  },
  "op:<": {
    short: "1 when the upper input is less than the lower, else 0",
    long: [
      "Gives 1 while the comparison holds and 0 while it does not, and nothing " +
        "where either input is missing.",
      "Wired into a total, it counts hours: total([PI-103] < 2, day) is how many " +
        "hours per day the pressure was below 2.",
    ],
  },
  "op:>=": {
    short: "1 when the upper input is greater than or equal to the lower, else 0",
    long: [
      "Gives 1 while the comparison holds and 0 while it does not, and nothing " +
        "where either input is missing.",
      "Wired into a total, it counts hours: total([FI-104] >= 5, day) is how many " +
        "hours per day the flow was 5 or more.",
    ],
  },
  "op:<=": {
    short: "1 when the upper input is less than or equal to the lower, else 0",
    long: [
      "Gives 1 while the comparison holds and 0 while it does not, and nothing " +
        "where either input is missing.",
      "Wired into a total, it counts hours: total([PI-103] <= 2, day) is how many " +
        "hours per day the pressure was 2 or less.",
    ],
  },
  "fn:abs": { short: "The value without its sign" },
  "fn:sqrt": {
    short: "Square root",
    long: ["Negative values have no square root and give a gap in the trend."],
  },
  "fn:ln": {
    short: "Natural logarithm",
    long: ["Zero and negative values have no logarithm and give a gap in the trend."],
  },
  "fn:log10": {
    short: "Base-10 logarithm",
    long: ["Zero and negative values have no logarithm and give a gap in the trend."],
  },
  "fn:exp": { short: "e to the power of the input" },
  "fn:round": {
    short: "Round to a whole number",
    long: ["Halves round up: 2.5 becomes 3, and -2.5 becomes -2."],
  },
  "fn:min": {
    short: "The smallest of the inputs - takes any number",
    long: [HOLES_SKIPPED],
  },
  "fn:max": {
    short: "The largest of the inputs - takes any number",
    long: [HOLES_SKIPPED],
  },
  "fn:avg": {
    short: "The average of the inputs - takes any number",
    long: [
      "The average across the inputs at each moment - not over time.",
      HOLES_SKIPPED,
    ],
  },
  "fn:total": {
    short: "Sum per hour, day, week, month or year of a rate per hour",
    long: [
      "Reads the input as a rate per hour and adds it up over each calendar " +
        "period, drawn as one step per period. A flow in m3/h becomes m3 per day; " +
        "a comparison (1 or 0) becomes the hours it held - e.g. how long a pump ran. " +
        "A rate per second needs × 3600 first.",
      "Periods follow the local calendar: the day summer time starts has 23 " +
        "hours, the day it ends 25. Weeks start on Monday. A period that began " +
        "before the plot's window is counted whole, and the current one is the " +
        "total so far.",
      "The tags inside are read as time-weighted averages. Auto resolution uses " +
        "1-minute averages for windows up to about a month and coarser ones " +
        "beyond. For a quantity the resolution hardly matters; for a comparison it " +
        "does - read per 1 h, an hour counts whole or not at all.",
    ],
  },
};
