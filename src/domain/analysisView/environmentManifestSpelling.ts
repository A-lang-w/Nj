import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";

/** Fewest characters of a fixed-length identifier family whose members need not carry a digit. */
const FIXED_LENGTH_MINIMUM = 8;

/** The distinct classes of a text's characters: digits, lower case, upper case and each other character. */
const characterClasses = (text: string): string =>
  [
    ...new Set(
      text
        .replaceAll(/\d/gu, "0")
        .replaceAll(/[a-z]/gu, "a")
        .replaceAll(/[A-Z]/gu, "A"),
    ),
  ]
    .sort(compare)
    .join("");

/** Every observed value has the value's length, at least eight, and together they use every class the value uses. */
const inFixedLengthFamily = (
  value: string,
  observed: readonly string[],
): boolean => {
  if (
    value.length < FIXED_LENGTH_MINIMUM ||
    observed.length < 2 ||
    observed.some((other) => other.length !== value.length)
  )
    return false;
  const used = new Set(
    observed.flatMap((other) => [...characterClasses(other)]),
  );
  return [...characterClasses(value)].every((kind) => used.has(kind));
};

/** Spelled like an observed identifier: a digit-bearing value with the length and character classes of one, or a member of their fixed-length family. */
export const spelledLikeObserved = (
  value: string,
  observed: ReadonlySet<string>,
): boolean => {
  const values = [...observed];
  if (inFixedLengthFamily(value, values)) return true;
  if (!/\d/u.test(value)) return false;
  const classes = characterClasses(value);
  return values.some(
    (other) =>
      other.length === value.length && characterClasses(other) === classes,
  );
};
