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

## The driving port

Everything above is reached through one object and nothing else:

```ts
const store = new TodoStore();
```

`add`, `complete`, `remove` and `list` are the whole driving surface. There is
no constructor argument, no module-level state, no factory, and no way to seed
the store except by calling `add`. An oracle that needed one of those would be
naming a port this design does not declare, and that is a design gap rather
than something to invent.

`UnknownTodoError` is the only failure this surface can produce. It is thrown,
never returned, and it carries the id it was given.

## Test substrate

- Test path scope: `test/`

Nothing is pre-written there. The oracle for each value is authored by DISTILL
— one executable file per value, plus any whole-file support it declares — and
software measures it red before any production byte is written. A locator is
`test/<file>.test.ts::<test name>`.

How an oracle is RUN is not this document's to say. `commands.ts` declares it,
along with how the project is typechecked, linted and tested, and the framework
reads those four declarations and derives nothing.
