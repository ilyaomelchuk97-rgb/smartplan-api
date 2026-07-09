/* ============================================================
   SmartPlan — МОКОВЫЕ ДАННЫЕ (демо-наполнение прототипа)
   Специфика участка УБиРОГС
   ============================================================ */

const MASTERS = [];

const OBJECTS = [
  { id:'o1',  addr:'ГРП-1, ул. Ленина, 5',           type:'ГРП',    lat:53.9020, lng:27.5610, zu:4, area_obj:120 },
  { id:'o2',  addr:'ШРП-12, ул. Советская, 18',      type:'ШРП',    lat:53.9097, lng:27.5710, zu:0, area_obj:60 },
  { id:'o3',  addr:'ШРП-8, ул. Пушкина, 3',          type:'ШРП',    lat:53.9085, lng:27.5650, zu:2, area_obj:45 },
  { id:'o4',  addr:'ГРП-3, пр. Независимости, 76',   type:'ГРП',    lat:53.9180, lng:27.5820, zu:0, area_obj:200 },
  { id:'o5',  addr:'Трасса Г-101, км 2-4',           type:'Трасса', lat:53.9030, lng:27.5380, zu:0, area_obj:0, length_km:2 },
  { id:'o6',  addr:'ШРП-5, ул. Кирова, 12',          type:'ШРП',    lat:53.8940, lng:27.5640, zu:1, area_obj:50 },
  { id:'o7',  addr:'ГРП-7, ул. Ратомская, 30',       type:'ГРП',    lat:53.8780, lng:27.5490, zu:0, area_obj:180 },
  { id:'o8',  addr:'Трасса Г-205, км 1-3',           type:'Трасса', lat:53.9130, lng:27.5440, zu:0, area_obj:0, length_km:2 },
  { id:'o9',  addr:'Просека, трасса Г-101, км 5-8',  type:'Просека',lat:53.9200, lng:27.5500, zu:0, area_obj:0, length_ha:3 },
  { id:'o10', addr:'Просека, трасса Г-205, км 4-7',  type:'Просека',lat:53.8950, lng:27.5300, zu:0, area_obj:0, length_ha:5 },
];

const WORK_TREE = [
  { id:'g1', name:'Благоустройство после земляных работ', children:[
    { id:'w1',  name:'Укладка асфальтобетонного покрытия', norm:0.5,  unit:'м2', min_temp:5,  season:'Лето' },
    { id:'w2',  name:'Укладка тротуарной плитки',           norm:0.4,  unit:'м2', min_temp:0,  season:'Круглый год' },
    { id:'w3',  name:'Устройство газона (посев)',           norm:0.25, unit:'м2', min_temp:5,  season:'Весна-осень' },
  ]},
  { id:'g2', name:'Ремонт зданий ГРП/ШРП', children:[
    { id:'w4',  name:'Ремонт кровли ГРП/ШРП',              norm:4.0,  unit:'объект', min_temp:-10, season:'Круглый год' },
    { id:'w5',  name:'Ремонт стен и отмосток',             norm:3.0,  unit:'объект', min_temp:-5,  season:'Круглый год' },
    { id:'w6',  name:'Ремонт отмостки (бетонные работы)',   norm:0.6,  unit:'м2',     min_temp:5,   season:'Лето' },
  ]},
  { id:'g3', name:'Покраска газопроводов и конструкций', children:[
    { id:'w7',  name:'Покраска газопровода',               norm:0.15, unit:'м2', min_temp:5,  season:'Лето' },
    { id:'w8',  name:'Покраска металлоконструкций',         norm:0.12, unit:'м2', min_temp:0,  season:'Круглый год' },
  ]},
  { id:'g4', name:'Очистка от снега', children:[
    { id:'w9',  name:'Очистка территории от снега',         norm:0.04, unit:'м2', depends_on_snow:true,  season:'Зима' },
    { id:'w10', name:'Очистка подъездных путей',            norm:0.06, unit:'м2', depends_on_snow:true,  season:'Зима' },
  ]},
  { id:'g5', name:'Расчистка лесопросек', children:[
    { id:'w11', name:'Расчистка просеки (валка деревьев)',  norm:8.0,  unit:'га', needs_permit:true, min_temp:-50, season:'Зима' },
    { id:'w12', name:'Уборка порубочных остатков',          norm:4.0,  unit:'га', min_temp:-10, season:'Зима' },
  ]},
  { id:'g6', name:'Иные СМР', children:[
    { id:'w13', name:'Земляные работы (разработка грунта)', norm:2.0, unit:'объект', needs_permit:true, season:'Круглый год' },
    { id:'w14', name:'Восстановление асфальта (ямочный)',    norm:0.3, unit:'м2',     min_temp:5, season:'Лето' },
  ]},
];

const TASK_SEED = [];

window.SP = {
  MASTERS, OBJECTS, WORK_TREE, TASK_SEED,
  WORK_MAP: {}, OBJ_MAP: {},
};
WORK_TREE.forEach(g => g.children.forEach(w => SP.WORK_MAP[w.id] = w));
OBJECTS.forEach(o => SP.OBJ_MAP[o.id] = o);
