import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    if (!(await knex.schema.hasTable("auto_update_log"))) {
        await knex.schema.createTable("auto_update_log", (table) => {
            table.increments("id");
            table.string("stack_name", 255).notNullable();
            table.string("status", 50).notNullable();
            table.text("error_message").notNullable().defaultTo("");
            table.text("old_images").notNullable().defaultTo("");
            table.text("new_images").notNullable().defaultTo("");
            table.string("created_at", 30).notNullable();
            table.index("stack_name");
            table.index("created_at");
        });
    }

    if (!(await knex.schema.hasTable("auto_update_backup"))) {
        await knex.schema.createTable("auto_update_backup", (table) => {
            table.increments("id");
            table.string("stack_name", 255).notNullable();
            table.text("compose_yaml").notNullable();
            table.string("created_at", 30).notNullable();
            table.index("stack_name");
        });
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("auto_update_backup");
    await knex.schema.dropTable("auto_update_log");
}
