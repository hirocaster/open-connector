import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "homebox";

const emptyInputSchema = s.actionInput({}, [], "No input is required for this action.");

const itemIdInput = { itemId: s.nonEmptyString("The item UUID returned by HomeBox.") };

const itemSummaryOutput = s.unknownObject("The item as returned by HomeBox.");

const attachmentTypeSchema = s.stringEnum("The attachment type.", [
  "photo",
  "manual",
  "warranty",
  "attachment",
  "receipt",
]);

const customFieldSchema = s.looseRequiredObject(
  "One custom field attached to the item. Exactly one of textValue, numberValue, or booleanValue should be set, matching the type.",
  {
    name: s.nonEmptyString("The field name, for example Color or Serial."),
    type: s.stringEnum("The field value type.", ["text", "number", "boolean", "time"]),
    textValue: s.string("The text value; used when type is text."),
    numberValue: s.integer("The numeric value; used when type is number."),
    booleanValue: s.boolean("The boolean value; used when type is boolean."),
  },
  { optional: ["textValue", "numberValue", "booleanValue"] },
);

const dateSchema = s.string("A date in YYYY-MM-DD format.", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const homeBoxActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_status",
    description: "Fetch the HomeBox instance status: health, version, and whether registration is open.",
    inputSchema: emptyInputSchema,
    outputSchema: s.actionOutput(
      { summary: s.unknownObject("The HomeBox status payload returned by the instance.") },
      "The HomeBox instance status.",
    ),
  }),
  defineProviderAction(service, {
    name: "list_items",
    description: "Search the HomeBox inventory with optional text search, pagination, and label/location filters.",
    inputSchema: s.actionInput(
      {
        q: s.string("Free-text search string."),
        page: s.integer("Page number, starting at 1."),
        pageSize: s.integer("Maximum number of items per page."),
        labelIds: s.array("Only items carrying any of these label UUIDs.", s.string("One label UUID.")),
        locationIds: s.array("Only items in any of these location UUIDs.", s.string("One location UUID.")),
        parentIds: s.array("Only items under any of these parent item UUIDs.", s.string("One parent item UUID.")),
        includeArchived: s.boolean("Include archived items in the result."),
        orderBy: s.string("Sort field, for example name or createdAt."),
      },
      [],
      "Input parameters for searching HomeBox items.",
    ),
    outputSchema: s.actionOutput(
      {
        items: s.array("The matching item summaries.", s.looseObject("One HomeBox item summary.")),
        page: s.integer("The current page number."),
        pageSize: s.integer("The page size used by the instance."),
        total: s.integer("The total number of matching items."),
      },
      "The matching HomeBox items.",
    ),
  }),
  defineProviderAction(service, {
    name: "get_item",
    description: "Fetch one HomeBox item with its full details, including attachments and custom fields.",
    inputSchema: s.actionInput(itemIdInput, ["itemId"], "Input parameters for fetching one item."),
    outputSchema: s.actionOutput({ item: itemSummaryOutput }, "The requested HomeBox item."),
  }),
  defineProviderAction(service, {
    name: "create_item",
    description: "Create a new HomeBox item with a name and optional description, location, and labels.",
    inputSchema: s.actionInput(
      {
        name: s.nonEmptyString("The item name."),
        description: s.string("An optional description."),
        locationId: s.string(
          "The UUID of the location the item lives in. HomeBox requires a location to create an item, so pass one or the create request fails with an HTTP 500.",
        ),
        labelIds: s.array("The UUIDs of labels to attach.", s.string("One label UUID.")),
        parentId: s.string("The UUID of a parent item, for sub-items."),
      },
      ["name"],
      "Input parameters for creating one HomeBox item.",
    ),
    outputSchema: s.actionOutput({ item: itemSummaryOutput }, "The created HomeBox item."),
  }),
  defineProviderAction(service, {
    name: "update_item",
    description:
      "Update one HomeBox item. Only the provided fields change; all other item data (serial number, warranty, custom fields, ...) is preserved. Custom fields are replaced as a whole when fields is provided.",
    inputSchema: s.actionInput(
      {
        itemId: s.nonEmptyString("The item UUID to update."),
        name: s.nonEmptyString("The item name."),
        description: s.nullableString("The item description; pass null to clear it."),
        quantity: s.integer("The item quantity."),
        insured: s.boolean("Whether the item is insured."),
        archived: s.boolean("Whether the item is archived."),
        locationId: s.nullableString("The location UUID, or null to unset it."),
        labelIds: s.array("The label UUIDs.", s.string("One label UUID.")),
        parentId: s.nullableString("The parent item UUID, or null to unset it."),
        serialNumber: s.string("The serial number."),
        modelNumber: s.string("The model number."),
        manufacturer: s.string("The manufacturer."),
        lifetimeWarranty: s.boolean("Whether the item has a lifetime warranty."),
        warrantyExpires: dateSchema,
        warrantyDetails: s.string("Warranty details."),
        purchaseTime: dateSchema,
        purchaseFrom: s.string("Where the item was purchased."),
        purchasePrice: s.string("The purchase price as a number string, for example 123.45."),
        soldTime: dateSchema,
        soldTo: s.string("Who the item was sold to."),
        soldPrice: s.string("The sale price as a number string."),
        soldNotes: s.string("Notes about the sale."),
        notes: s.string("Free-form item notes."),
        fields: s.array("The custom fields to set; replaces all existing fields.", customFieldSchema),
      },
      ["itemId"],
      "Input parameters for updating one HomeBox item.",
    ),
    outputSchema: s.actionOutput({ item: itemSummaryOutput }, "The updated HomeBox item."),
  }),
  defineProviderAction(service, {
    name: "delete_item",
    description: "Delete one HomeBox item.",
    inputSchema: s.actionInput(itemIdInput, ["itemId"], "Input parameters for deleting one item."),
    outputSchema: s.actionOutput({ deleted: s.boolean("Whether the item was deleted.") }, "The deletion result."),
  }),
  defineProviderAction(service, {
    name: "list_locations",
    description: "List all HomeBox locations with their item counts.",
    inputSchema: emptyInputSchema,
    outputSchema: s.actionOutput(
      {
        locations: s.array("The locations.", s.looseObject("One HomeBox location with its item count.")),
      },
      "The HomeBox locations.",
    ),
  }),
  defineProviderAction(service, {
    name: "create_location",
    description: "Create a new HomeBox location, optionally nested under a parent location.",
    inputSchema: s.actionInput(
      {
        name: s.nonEmptyString("The location name."),
        description: s.string("An optional location description."),
        parentId: s.string("The UUID of the parent location, for nested locations."),
      },
      ["name"],
      "Input parameters for creating one HomeBox location.",
    ),
    outputSchema: s.actionOutput(
      { location: s.looseObject("The created HomeBox location.") },
      "The created HomeBox location.",
    ),
  }),
  defineProviderAction(service, {
    name: "delete_location",
    description: "Delete one HomeBox location.",
    inputSchema: s.actionInput(
      { locationId: s.nonEmptyString("The location UUID to delete.") },
      ["locationId"],
      "Input parameters for deleting one HomeBox location.",
    ),
    outputSchema: s.actionOutput({ deleted: s.boolean("Whether the location was deleted.") }, "The deletion result."),
  }),
  defineProviderAction(service, {
    name: "list_labels",
    description: "List all HomeBox labels.",
    inputSchema: emptyInputSchema,
    outputSchema: s.actionOutput(
      { labels: s.array("The labels.", s.looseObject("One HomeBox label.")) },
      "The HomeBox labels.",
    ),
  }),
  defineProviderAction(service, {
    name: "create_label",
    description: "Create a new HomeBox label.",
    inputSchema: s.actionInput(
      {
        name: s.nonEmptyString("The label name."),
        description: s.string("An optional label description."),
        color: s.string("A label color, for example #ff0000."),
      },
      ["name"],
      "Input parameters for creating one HomeBox label.",
    ),
    outputSchema: s.actionOutput({ label: s.looseObject("The created HomeBox label.") }, "The created HomeBox label."),
  }),
  defineProviderAction(service, {
    name: "delete_label",
    description: "Delete one HomeBox label.",
    inputSchema: s.actionInput(
      { labelId: s.nonEmptyString("The label UUID to delete.") },
      ["labelId"],
      "Input parameters for deleting one HomeBox label.",
    ),
    outputSchema: s.actionOutput({ deleted: s.boolean("Whether the label was deleted.") }, "The deletion result."),
  }),
  defineProviderAction(service, {
    name: "get_group_statistics",
    description: "Fetch the HomeBox group dashboard statistics: total items, locations, labels, price, and warranties.",
    inputSchema: emptyInputSchema,
    outputSchema: s.actionOutput(
      { statistics: s.unknownObject("The HomeBox group statistics payload.") },
      "The HomeBox group statistics.",
    ),
  }),
  defineProviderAction(service, {
    name: "add_item_attachment",
    description:
      "Attach a file (photo or document) to one HomeBox item. The file type is detected from the extension when omitted.",
    inputSchema: s.actionInput(
      {
        itemId: s.nonEmptyString("The item UUID to attach the file to."),
        file: s.transitFile("The file to attach."),
        type: attachmentTypeSchema,
        name: s.string("Override the stored file name, including the extension."),
      },
      ["itemId", "file"],
      "Input parameters for attaching one file to an item.",
    ),
    outputSchema: s.actionOutput({ item: itemSummaryOutput }, "The HomeBox item with the new attachment."),
  }),
  defineProviderAction(service, {
    name: "get_maintenance_log",
    description:
      "Fetch the maintenance log of one HomeBox item, optionally filtered to completed or scheduled entries.",
    inputSchema: s.actionInput(
      {
        itemId: s.nonEmptyString("The item UUID."),
        completed: s.boolean("Only include completed maintenance entries."),
        scheduled: s.boolean("Only include scheduled (upcoming) maintenance entries."),
      },
      ["itemId"],
      "Input parameters for fetching one maintenance log.",
    ),
    outputSchema: s.actionOutput(
      {
        itemId: s.string("The item the log belongs to."),
        costAverage: s.number("The average maintenance cost across the entries."),
        costTotal: s.number("The total maintenance cost across the entries."),
        entries: s.array("The maintenance entries.", s.looseObject("One maintenance entry.")),
      },
      "The HomeBox maintenance log.",
    ),
  }),
  defineProviderAction(service, {
    name: "add_maintenance_entry",
    description:
      "Add a maintenance entry (repair, inspection, scheduled service) to one HomeBox item. Provide completedDate, scheduledDate, or both.",
    inputSchema: s.actionInput(
      {
        itemId: s.nonEmptyString("The item UUID."),
        name: s.nonEmptyString("The maintenance entry name, for example Air filter replacement."),
        completedDate: dateSchema,
        scheduledDate: dateSchema,
        description: s.string("An optional description of the maintenance work."),
        cost: s.string("The maintenance cost as a number string, for example 1500."),
      },
      ["itemId", "name"],
      "Input parameters for adding one maintenance entry.",
    ),
    outputSchema: s.actionOutput(
      { entry: s.looseObject("The created maintenance entry.") },
      "The created HomeBox maintenance entry.",
    ),
  }),
  defineProviderAction(service, {
    name: "list_custom_field_names",
    description: "List the custom field names in use across the HomeBox group.",
    inputSchema: emptyInputSchema,
    outputSchema: s.actionOutput(
      { names: s.array("The custom field names.", s.string("One custom field name.")) },
      "The HomeBox custom field names.",
    ),
  }),
  defineProviderAction(service, {
    name: "list_custom_field_values",
    description: "List the values in use for one custom field name across the HomeBox group.",
    inputSchema: s.actionInput(
      { field: s.nonEmptyString("The custom field name, for example Color.") },
      ["field"],
      "Input parameters for listing one custom field's values.",
    ),
    outputSchema: s.actionOutput(
      { values: s.array("The custom field values.", s.string("One custom field value.")) },
      "The HomeBox custom field values.",
    ),
  }),
];
