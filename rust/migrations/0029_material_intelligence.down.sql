do $$ begin
    if to_regclass('studio_material_intelligence') is not null then
        if exists(select 1 from studio_material_intelligence) then
            raise exception 'material intelligence contains records; refusing lossy rollback';
        end if;
    end if;
end $$;
drop table if exists studio_material_intelligence;
