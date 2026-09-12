/**
 * A todo list, as a walking skeleton.
 *
 * `add` and `list` are implemented. `complete` and `remove` are STUBS: the
 * symbols exist with their declared signatures, and their bodies throw. That
 * shape is deliberate — a `replace-symbol` effect names an existing symbol, so
 * a stub is what gives DELIVER something to write into, and the missing
 * behaviour is a gap in a body rather than a gap in the surface.
 *
 * The declared surface is `design.md`. Nothing here may grow a method, a type
 * or a parameter that document does not name.
 */

/** One item on the list. `id` is assigned by the store and never reused. */
export type Todo = { id: string; title: string; done: boolean };

/** What `list` may be narrowed to. Defaults to `all`. */
export type TodoFilter = "all" | "active" | "done";

/** Thrown when a method is given an id the store does not hold. */
export class UnknownTodoError extends Error {
  constructor(id: string) {
    super(`no todo ${id}`);
    this.name = "UnknownTodoError";
  }
}

export class TodoStore {
  #todos: Todo[] = [];
  #next = 1;

  add(title: string): Todo {
    const todo: Todo = { id: `t-${this.#next}`, title, done: false };
    this.#next += 1;
    this.#todos.push(todo);
    return todo;
  }

  complete(id: string): Todo {
    throw new Error("not implemented");
  }

  remove(id: string): void {
    throw new Error("not implemented");
  }

  list(filter: TodoFilter = "all"): Todo[] {
    if (filter === "active") return this.#todos.filter((t) => !t.done);
    if (filter === "done") return this.#todos.filter((t) => t.done);
    return [...this.#todos];
  }
}
