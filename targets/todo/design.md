# Todo store — the design

The authority for `src/todo.ts`. It declares the whole public surface. Nothing
may be added to it: a step that needs a method, a type, a parameter or an error
this document does not name has found a design gap, and a design gap is
surfaced to a person rather than closed by inventing the surface.

## Public surface

```ts
export type Todo = { id: string; title: string; done: boolean };
export type TodoFilter = "all" | "active" | "done";
export class UnknownTodoError extends Error {}

export class TodoStore {
  add(title: string): Todo;
  complete(id: string): Todo;
  remove(id: string): void;
  list(filter?: TodoFilter): Todo[];
}
```

There is no other exported symbol, no other method on `TodoStore`, and no other
error type.

## Behaviour

- **`add(title)`** appends a todo with that title, `done: false`, and an id the
  store assigns and never reuses. It returns the todo it appended. *Implemented.*
- **`complete(id)`** sets `done: true` on the todo with that id and returns it.
  An id the store does not hold throws `UnknownTodoError`. *Stub.*
- **`remove(id)`** drops the todo with that id from the store and returns
  nothing. An id the store does not hold throws `UnknownTodoError`. *Stub.*
- **`list(filter)`** returns the todos in insertion order. `all` (the default)
  returns every todo, `active` returns the ones that are not done, `done`
  returns the ones that are. *Implemented.*

`complete` and `remove` are stubs whose bodies are `throw new Error("not
implemented")`. The symbols exist with the signatures above; only the bodies are
missing.

## Acceptance tests

Pre-authored in `test/todo.test.ts`. The two implemented behaviours are active;
the two stubs are pending behind `test.skip(`, which DELIVER's oracle locates
and activates. A pending test's locator is `test/todo.test.ts::<test name>`.

| State | Locator |
|---|---|
| active | `test/todo.test.ts::add returns a todo with the given title, not done` |
| active | `test/todo.test.ts::add assigns a distinct id to every todo` |
| active | `test/todo.test.ts::list returns every todo in insertion order` |
| active | `test/todo.test.ts::list narrowed to active returns the todos that are not done` |
| pending | `test/todo.test.ts::complete marks the todo done and list narrowed to done returns it` |
| pending | `test/todo.test.ts::complete throws UnknownTodoError for an id the store does not hold` |
| pending | `test/todo.test.ts::remove drops the todo so list no longer returns it` |
| pending | `test/todo.test.ts::remove throws UnknownTodoError for an id the store does not hold` |
