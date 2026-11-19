import { z } from "zod";

// The generated output schemas are strict objects, which the MCP SDK turns into
// `additionalProperties: false`. The API sends fields the specs don't list, so
// strict output schemas reject real responses. Loosen every object in an
// output schema so extra fields pass through. Inputs stay strict.
export function looseOutput(schema: z.ZodType): z.ZodType {
	let out: z.ZodType = schema;
	if (schema instanceof z.ZodObject) {
		const shape = Object.fromEntries(
			Object.entries(schema.shape).map(([k, v]) => [
				k,
				looseOutput(v as z.ZodType),
			]),
		);
		out = z.looseObject(shape);
	} else if (schema instanceof z.ZodArray) {
		out = z.array(looseOutput(schema.element as z.ZodType));
	} else if (schema instanceof z.ZodOptional) {
		out = looseOutput(schema.unwrap() as z.ZodType).optional();
	} else if (schema instanceof z.ZodNullable) {
		out = looseOutput(schema.unwrap() as z.ZodType).nullable();
	} else {
		return schema;
	}
	const meta = z.globalRegistry.get(schema);
	return meta ? out.register(z.globalRegistry, meta) : out;
}
