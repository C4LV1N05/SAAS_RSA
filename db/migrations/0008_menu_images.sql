-- 0008_menu_images.sql
-- Photos for menu items. The API resizes uploads to two WebP sizes and stores
-- them in blob storage; these columns hold their public URLs.
alter table menu_items add column image_url text;        -- 640 x 640, for the larger view
alter table menu_items add column image_thumb_url text;  -- 320 x 320, for the menu list
