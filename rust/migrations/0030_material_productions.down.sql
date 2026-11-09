-- Losing source lineage could make a restricted derivative appear independent after rollback.
do $$ begin
    if to_regclass('studio_material_productions') is not null then
        if exists(select 1 from studio_material_productions) then
            raise exception 'material productions contain provenance; refusing lossy rollback';
        end if;
    end if;
end $$;
drop table if exists studio_material_productions;
