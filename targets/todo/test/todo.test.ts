/**
 * The acceptance tests.
 *
 * `add` and `list` are implemented, so their tests are ACTIVE. `complete` and
 * `remove` are stubs, so their tests are PENDING — pre-authored bodies behind
 * `test.skip(`, which is the marker convention DELIVER's oracle locates and
 * `activate-at` strips. Every skipped test's name is an oracle locator a
 * roadmap obligation names: `test/todo.test.ts::<test name>`.
 *
 * Nothing in DELIVER may write an assertion here. The bodies below are the
 * contract; the step cycle activates them and is then measured against them.
 */

import { describe, expect, test } from "bun:test";
import { TodoStore, UnknownTodoError } from "../src/todo.ts";

describe("add", () => {
  test("add returns a todo with the given title, not done", () => {
    const store = new TodoStore();
    const todo = store.add("write the design");
    expect(todo.title).toBe("write the design");
    expect(todo.done).toBe(false);
    expect(todo.id.length).toBeGreaterThan(0);
  });

  test("add assigns a distinct id to every todo", () => {
    const store = new TodoStore();
    const ids = ["a", "b", "c"].map((title) => store.add(title).id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("list", () => {
  test("list returns every todo in insertion order", () => {
    const store = new TodoStore();
    store.add("first");
    store.add("second");
    expect(store.list().map((t) => t.title)).toEqual(["first", "second"]);
  });

  test("list narrowed to active returns the todos that are not done", () => {
    const store = new TodoStore();
    store.add("first");
    store.add("second");
    expect(store.list("active").map((t) => t.title)).toEqual(["first", "second"]);
    expect(store.list("done")).toEqual([]);
  });
});

describe("complete", () => {
  test.skip("complete marks the todo done and list narrowed to done returns it", () => {
    const store = new TodoStore();
    const todo = store.add("ship the cut");
    const completed = store.complete(todo.id);
    expect(completed.done).toBe(true);
    expect(store.list("done").map((t) => t.title)).toEqual(["ship the cut"]);
    expect(store.list("active")).toEqual([]);
  });

  test.skip("complete throws UnknownTodoError for an id the store does not hold", () => {
    const store = new TodoStore();
    store.add("ship the cut");
    expect(() => store.complete("t-999")).toThrow(UnknownTodoError);
  });
});

describe("remove", () => {
  test.skip("remove drops the todo so list no longer returns it", () => {
    const store = new TodoStore();
    const kept = store.add("keep me");
    const dropped = store.add("drop me");
    store.remove(dropped.id);
    expect(store.list().map((t) => t.title)).toEqual([kept.title]);
  });

  test.skip("remove throws UnknownTodoError for an id the store does not hold", () => {
    const store = new TodoStore();
    store.add("keep me");
    expect(() => store.remove("t-999")).toThrow(UnknownTodoError);
  });
});
