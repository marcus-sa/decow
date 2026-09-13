/**
 * A form from a JSON Schema, for the places a person supplies a value: the
 * input a run is started with, the input a pipeline is driven over, and the
 * answer a suspension is resumed with.
 *
 * Deliberately small. It renders the shapes the registered schemas actually
 * use — strings, numbers, booleans, and a closed enum — and anything else it
 * hands over as JSON in a text area rather than guessing at a widget. The
 * server parses whatever is posted with the schema's own zod type, so a form
 * that is too simple costs a person a paste, and a form that invented a widget
 * would cost them a refusal they could not read.
 *
 * TWO KINDS OF CLOSED LIST, and they are closed by different authorities. A
 * schema `enum` is closed by the TYPE — the set is in the schema and cannot be
 * anything else. A field's `choices` are closed by a REGISTRATION — the set is
 * whatever a consumer's own function returned this time, so it may be empty,
 * and a value outside it is refused by the schema rather than by this form.
 * The second is why an empty option leads the list: a person who has picked
 * nothing has picked nothing, which is not the same as having picked the first
 * thing on offer.
 */

import { useState } from "react";

/** As much of a JSON Schema as a form needs to read. */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  items?: JsonSchema;
};

/**
 * What every field starts at: the caller's value where it has one, the
 * schema's own shape otherwise.
 *
 * A field with `choices` starts EMPTY rather than at the first option, because
 * the options are a consumer's set rather than the schema's: an empty list has
 * no first option, and a full one has no option a person has agreed to.
 */
const initial = (
  schema: JsonSchema,
  choices: Record<string, Choice[]>,
  supplied: Record<string, unknown>,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (name in supplied) values[name] = supplied[name];
    else if (name in choices) values[name] = "";
    else if (Array.isArray(property.enum)) values[name] = String(property.enum[0] ?? "");
    else if (property.type === "boolean") values[name] = false;
    else if (property.type === "number" || property.type === "integer") values[name] = 0;
    else if (property.type === "string") values[name] = "";
  }
  return values;
};

/** One option a field may be set to, as a registration declared it. */
export type Choice = { value: string; label?: string };

export type SchemaFormProps = {
  schema: JsonSchema;
  submitLabel: string;
  onSubmit: (value: Record<string, unknown>) => void;
  /**
   * The closed list a field is picked from, keyed by field name. A field that
   * is absent is rendered from its schema.
   */
  choices?: Record<string, Choice[]>;
  /** What the fields start at. The schema's own shape for anything absent. */
  values?: Record<string, unknown>;
  /** What the server said when it refused the last attempt. */
  error?: string;
  busy?: boolean;
};

export const SchemaForm = (props: SchemaFormProps): React.ReactElement => {
  const choices = props.choices ?? {};
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initial(props.schema, choices, props.values ?? {}),
  );
  const properties = Object.entries(props.schema.properties ?? {});
  const required = new Set(props.schema.required ?? []);

  const set = (name: string, value: unknown): void => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        // A field left empty is absent rather than "": the schema decides
        // whether an optional field may be missing, and "" is a value.
        const body = Object.fromEntries(
          Object.entries(values).filter(([, value]) => value !== "" && value !== undefined),
        );
        props.onSubmit(body);
      }}
    >
      {properties.length === 0 ? <p className="meta">This graph takes no input.</p> : null}

      {properties.map(([name, property]) => (
        <label key={name} className="field">
          <span>
            {name}
            {required.has(name) ? "" : " (optional)"}
          </span>
          {choices[name] !== undefined ? (
            <select
              data-testid={`field-${name}`}
              value={String(values[name] ?? "")}
              onChange={(e) => set(name, e.target.value)}
            >
              <option value="">choose one</option>
              {(choices[name] ?? []).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label ?? choice.value}
                </option>
              ))}
            </select>
          ) : Array.isArray(property.enum) ? (
            <select
              data-testid={`field-${name}`}
              value={String(values[name] ?? "")}
              onChange={(e) => set(name, e.target.value)}
            >
              {property.enum.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          ) : property.type === "boolean" ? (
            <input
              type="checkbox"
              data-testid={`field-${name}`}
              checked={values[name] === true}
              onChange={(e) => set(name, e.target.checked)}
            />
          ) : property.type === "number" || property.type === "integer" ? (
            <input
              type="number"
              data-testid={`field-${name}`}
              value={String(values[name] ?? "")}
              onChange={(e) => set(name, Number(e.target.value))}
            />
          ) : property.type === "string" ? (
            <textarea
              data-testid={`field-${name}`}
              rows={name.length > 6 ? 4 : 2}
              value={String(values[name] ?? "")}
              onChange={(e) => set(name, e.target.value)}
            />
          ) : (
            <textarea
              data-testid={`field-${name}`}
              rows={4}
              placeholder="JSON"
              onChange={(e) => {
                try {
                  set(name, JSON.parse(e.target.value));
                } catch {
                  set(name, e.target.value);
                }
              }}
            />
          )}
          {choices[name]?.length === 0 ? (
            <span className="meta">Nothing to pick from yet.</span>
          ) : null}
          {property.description === undefined ? null : (
            <span className="meta">{property.description}</span>
          )}
        </label>
      ))}

      {props.error === undefined ? null : <p className="error">{props.error}</p>}

      <button type="submit" disabled={props.busy === true}>
        {props.busy === true ? "…" : props.submitLabel}
      </button>
    </form>
  );
};
