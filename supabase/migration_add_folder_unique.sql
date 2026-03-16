-- Run this if you already have the schema applied and need to add the missing
-- unique constraint on folders so CSV binder/deck import works correctly.
alter table folders
  add constraint folders_user_id_name_type_key unique (user_id, name, type);
