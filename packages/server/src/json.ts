/**
 * What crosses the wire.
 *
 * Everything this server reports to a browser goes through a server function,
 * and a server function's return value is serialized — so the types it returns
 * have to SAY they are serializable. `unknown` does not: it is the type of a
 * value nobody has looked at, and the boundary needs the type of a value that
 * survives a round trip.
 *
 * Every place this replaces an `unknown` is a place the value was already JSON
 * in fact and typed as `unknown` only because the framework had no reason to
 * care: a JSON Schema, a form's input, an artifact row body stored as JSON
 * text, a suspension's trail on its way to a person. The cast that widens a
 * core `unknown` into one of these happens once, at the boundary that knows.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A core `unknown` read AS the JSON it is.
 *
 * Named rather than inlined so every one of these is greppable: each is a
 * claim that the value came from, or is on its way to, a JSON document.
 */
export const asJson = (value: unknown): Json => value as Json;
