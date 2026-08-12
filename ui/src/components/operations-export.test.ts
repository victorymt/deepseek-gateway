import { describe, expect, test } from "vitest"

import { toCsv } from "./operations-export"

describe("toCsv", () => {
  test("escapes commas, quotes, and line breaks", () => {
    expect(
      toCsv(["name", "message"], [
        ["alpha, one", 'said "hello"'],
        ["line\nitem", "plain"],
      ])
    ).toBe(
      'name,message\r\n"alpha, one","said ""hello"""\r\n"line\nitem",plain'
    )
  })

  test("serializes nullish values as empty cells", () => {
    expect(toCsv(["a", "b", "c"], [[null, undefined, 0]])).toBe(
      "a,b,c\r\n,,0"
    )
  })

  test("leaves BOM handling to the download layer", () => {
    expect(toCsv(["列"], [["值"]]).startsWith("\ufeff")).toBe(false)
  })
})
