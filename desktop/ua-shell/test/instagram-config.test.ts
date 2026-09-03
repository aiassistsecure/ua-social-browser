/**
 * Guards on the Instagram composer config, and on the shape of every config
 * that drives a multi-screen composer.
 *
 * Instagram's adapter was written from product knowledge and could never have
 * worked. Three of its selectors were wrong in ways reading could not catch,
 * and each was only found by driving a real signed-in account on 2026-09-03:
 *
 *  - `opener` matched `svg[aria-label="New post"]` rather than the
 *    `<a role="link">` around it. `SVGElement` has no `.click()`, so opening
 *    the composer threw a TypeError every time.
 *  - the crop and filter steps clicked "the first enabled `div[role=button]`",
 *    which on both screens is **Back** — five matches on crop, six on the
 *    caption screen, Back first in document order.
 *  - `mediaAttached` looked for an `<img>` or `<canvas>`; Instagram uses a
 *    `background-image: url(blob:…)` on a bare div, so the dialog contains no
 *    image element at all.
 *
 * These tests do not re-verify the DOM — nothing here can, without an account.
 * They lock in the *properties* that made the old config unsafe, so the next
 * person cannot reintroduce a step that clicks whatever comes first or a step
 * whose success cannot be checked.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COMPOSERS, composerConfigFor } from "../src/publisher/adapters";

const instagram = composerConfigFor("instagram")!;

/**
 * Whether a selector could match several controls on one screen.
 *
 * Precision matters here or the guard cries wolf: a first draft flagged
 * Pinterest, whose submit is `[data-test-id="board-dropdown-save-button"]
 * button, button[type="submit"]` — both alternatives genuinely narrowed. It
 * matched on the bare word "button".
 *
 * The real test is whether anything *other than a generic role* narrows the
 * selector. `div[role="dialog"] div[role="button"]` names no attribute that
 * distinguishes one control from its neighbours, so it matches Back, Next and
 * everything else. Anything carrying an id, a class, a data attribute, an
 * aria-label or a type is picking out a specific control.
 */
function isLoose(selector: string): boolean {
  return selector.split(",").some((alternative) => {
    const withoutGenericRoles = alternative.replace(
      /\[role="(button|link|dialog|textbox|heading)"\]/g,
      "",
    );
    // Nothing left that narrows it: no attribute, class or id.
    return !/[[.#]/.test(withoutGenericRoles) && /\w/.test(withoutGenericRoles);
  });
}

describe("the Instagram composer config", () => {
  test("the opener can reach the clickable ancestor, not only the icon", () => {
    // The bare `svg[...]` alternative may stay — the driver walks up from any
    // match — but something in the list has to name a real control, or the
    // config is relying entirely on that walk.
    assert.ok(instagram.opener, "Instagram hides its composer behind a button");
    assert.match(
      instagram.opener,
      /a\[role="link"\]|div\[role="button"\]/,
      "the opener must name the anchor or button that carries the click handler",
    );
  });

  test("the attached-picture check does not look for an image element", () => {
    // There is no <img> or <canvas> in Instagram's dialog. A check that looks
    // for one never fires, and the flow would submit before the picture is in
    // — a different post from the approved one.
    assert.ok(instagram.mediaAttached);
    assert.doesNotMatch(
      instagram.mediaAttached,
      /\bimg\b|\bcanvas\b/,
      "Instagram renders the attachment as a blob background, not an element",
    );
    assert.match(instagram.mediaAttached, /blob:/);
  });

  test("the submit names Share, because the selector alone finds Back first", () => {
    assert.equal(instagram.submitText, "Share");
    assert.ok(
      isLoose(instagram.submit),
      "if this selector ever becomes specific, the text qualifier can go",
    );
  });

  test("both screens between the upload and the caption name their control", () => {
    const steps = instagram.afterAttach ?? [];
    assert.equal(steps.length, 2, "crop and filter");

    for (const step of steps) {
      assert.equal(
        step.clickText,
        "Next",
        `the ${step.label} step must say which control it means`,
      );
    }
  });

  test("neither step waits on something that is already true", () => {
    // `waitFor: 'div[role="dialog"]'` was the original bug: the dialog is on
    // screen for the whole flow, so the step passed without advancing.
    for (const step of instagram.afterAttach ?? []) {
      assert.notEqual(
        step.waitFor,
        'div[role="dialog"]',
        `the ${step.label} step cannot be satisfied by the dialog it is already in`,
      );
    }
  });
});

describe("every multi-screen composer", () => {
  const withSteps = Object.entries(COMPOSERS).filter(
    ([, cfg]) => (cfg?.afterAttach?.length ?? 0) > 0,
  );

  test("there is at least one, or these guards are vacuous", () => {
    assert.ok(withSteps.length > 0);
  });

  for (const [network, cfg] of withSteps) {
    test(`${network}: each step can prove it landed`, () => {
      for (const step of cfg!.afterAttach!) {
        assert.ok(
          step.waitFor || step.waitForHeading,
          `${network}'s ${step.label} step has nothing to wait for, so a click on it could never be verified`,
        );
      }
    });

    test(`${network}: a step using a loose selector names its control`, () => {
      for (const step of cfg!.afterAttach!) {
        if (!isLoose(step.click)) continue;
        assert.ok(
          step.clickText,
          `${network}'s ${step.label} step would click whichever control comes first`,
        );
      }
    });
  }
});

describe("every composer's submit", () => {
  test("a loose submit selector is always qualified by text", () => {
    // The failure this prevents is not cosmetic: clicking the wrong control on
    // a caption screen leaves the composer, and the flow then reports that the
    // post could not be sent while the operator watches it do nothing.
    for (const [network, cfg] of Object.entries(COMPOSERS)) {
      if (!cfg) continue;
      if (!isLoose(cfg.submit)) continue;
      assert.ok(
        cfg.submitText || cfg.submitHotkey,
        `${network}'s submit selector is loose and has neither a text qualifier nor a hotkey fallback`,
      );
    }
  });
});
