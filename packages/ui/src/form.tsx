/**
 * A form from a JSON Schema, for the two places a person supplies a value:
 * the input a run is started with, and the answer a suspension is resumed
 * with.
 *
 * Deliberately small. It renders the shapes the registered schemas actually
 * use — strings, numbers, booleans, and a closed enum — and anything else it
 * hands over as JSON in a text area rather than guessing at a widget. The
 * server parses whatever is posted with the schema's own zod type, so a form
 * that is too simple costs a person a paste, and a form that invented a widget
 * would cost them a refusal they could not read.
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

const initial = (schema: JsonSchema): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (Array.isArray(property.enum)) values[name] = String(property.enum[0] ?? "");
    else if (property.type === "boolean") values[name] = false;
    else if (property.type === "number" || property.type === "integer") values[name] = 0;
    else if (property.type === "string") values[name] = "";
  }
  return values;
};

export type SchemaFormProps = {
  schema: JsonSchema;
  submitLabel: string;
  onSubmit: (value: Record<string, unknown>) => void;
  /** What the server said when it refused the last attempt. */
  error?: string;
  busy?: boolean;
};

export const SchemaForm = (props: SchemaFormProps): React.ReactElement => {
  const [values, setValues] = useState<Record<string, unknown>>(() => initial(props.schema));
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
          {Array.isArray(property.enum) ? (
            <select value={String(values[name] ?? "")} onChange={(e) => set(name, e.target.value)}>
              {property.enum.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          ) : property.type === "boolean" ? (
            <input
              type="checkbox"
              checked={values[name] === true}
              onChange={(e) => set(name, e.target.checked)}
            />
          ) : property.type === "number" || property.type === "integer" ? (
            <input
              type="number"
              value={String(values[name] ?? "")}
              onChange={(e) => set(name, Number(e.target.value))}
            />
          ) : property.type === "string" ? (
            <textarea
              rows={name.length > 6 ? 4 : 2}
              value={String(values[name] ?? "")}
              onChange={(e) => set(name, e.target.value)}
            />
          ) : (
            <textarea
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
