-- Custom SQL migration file, put your code below! --
UPDATE "request_services" SET "type" = 'server' WHERE "type" = 'tofa';
