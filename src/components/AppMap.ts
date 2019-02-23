import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-defaulticon-compatibility/dist/leaflet-defaulticon-compatibility.webpack.css';
import 'leaflet-defaulticon-compatibility';
import 'leaflet-sidebar-v2';
import 'leaflet-sidebar-v2/css/leaflet-sidebar.css';

import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';

import debounce from 'lodash/debounce';
import Vue from 'vue';
import Component, {mixins} from 'vue-class-component';

import {MapBase, SHOW_ALL_OBJS_FOR_MAP_UNIT_EVENT} from '@/MapBase';
import * as MapIcons from '@/MapIcon';
import * as MapMarkers from '@/MapMarker';
import {MapMarker, SearchResultUpdateMode} from '@/MapMarker';
import {MapMarkerGroup} from '@/MapMarkerGroup';
import {SearchResultGroup, SearchExcludeSet, SEARCH_PRESETS} from '@/MapSearch';

import MixinUtil from '@/components/MixinUtil';
import AppMapDetailsDungeon from '@/components/AppMapDetailsDungeon';
import AppMapDetailsObj from '@/components/AppMapDetailsObj';
import AppMapFilterMainButton from '@/components/AppMapFilterMainButton';
import AppMapSettings from '@/components/AppMapSettings';
import ModalGotoCoords from '@/components/ModalGotoCoords';
import ObjectInfo from '@/components/ObjectInfo';

import {MapMgr, ObjectData, ObjectMinData} from '@/services/MapMgr';
import {MsgMgr} from '@/services/MsgMgr';

import * as map from '@/util/map';
import {Point} from '@/util/map';
import {Settings} from '@/util/settings';
import * as ui from '@/util/ui';
import '@/util/leaflet_tile_workaround.js';

function valueOrDefault<T>(value: T|undefined, defaultValue: T) {
  return value === undefined ? defaultValue : value;
}

interface MarkerComponent {
  cl: any;
  detailsComponent?: string;
  preloadPad?: number;
  enableUpdates?: boolean;

  filterIcon: string,
  filterLabel: string,
}

const MARKER_COMPONENTS: {[type: string]: MarkerComponent} = Object.freeze({
  'Location': {
    cl: MapMarkers.MapMarkerLocation,
    preloadPad: 0.6,
    filterIcon: MapIcons.CHECKPOINT.options.iconUrl,
    filterLabel: 'Locations',
  },
  'Dungeon': {
    cl: MapMarkers.MapMarkerDungeon,
    detailsComponent: 'AppMapDetailsDungeon',
    enableUpdates: false,
    filterIcon: MapIcons.DUNGEON.options.iconUrl,
    filterLabel: 'Shrines',
   },
  'Place': {
    cl: MapMarkers.MapMarkerPlace,
    filterIcon: MapIcons.VILLAGE.options.iconUrl,
    filterLabel: 'Places',
   },
  'Tower': {
    cl: MapMarkers.MapMarkerTower,
    enableUpdates: false,
    filterIcon: MapIcons.TOWER.options.iconUrl,
    filterLabel: 'Towers',
   },
  'Shop': {
    cl: MapMarkers.MapMarkerShop,
    filterIcon: MapIcons.SHOP_YOROZU.options.iconUrl,
    filterLabel: 'Shops',
   },
  'Labo': {
    cl: MapMarkers.MapMarkerLabo,
    enableUpdates: false,
    filterIcon: MapIcons.LABO.options.iconUrl,
    filterLabel: 'Tech Labs',
   },
  'Korok': {
    cl: MapMarkers.MapMarkerKorok,
    enableUpdates: false,
    filterIcon: MapIcons.KOROK.options.iconUrl,
    filterLabel: 'Koroks',
   },
});

function getMarkerDetailsComponent(marker: MapMarker): string {
  if (marker instanceof MapMarkers.MapMarkerObj || marker instanceof MapMarkers.MapMarkerSearchResult)
    return 'AppMapDetailsObj';

  for (const component of Object.values(MARKER_COMPONENTS)) {
    if (marker instanceof component.cl)
      return valueOrDefault(component.detailsComponent, '');
  }
  return '';
}

@Component({
  components: {
    AppMapDetailsDungeon,
    AppMapDetailsObj,
    AppMapFilterMainButton,
    AppMapSettings,
    ModalGotoCoords,
    ObjectInfo,
  },
})
export default class AppMap extends mixins(MixinUtil) {
  private map!: MapBase;
  private updatingRoute = false;
  private zoom = map.DEFAULT_ZOOM;

  private sidebar!: L.Control.Sidebar;
  private sidebarActivePane = '';
  private sidebarPaneScrollPos: Map<string, number> = new Map();
  private drawControlEnabled = false;
  private drawControl: any;

  private previousGotoMarker: L.Marker|null = null;
  private greatPlateauBarrierShown = false;

  private detailsComponent = '';
  private detailsMarker: ui.Unobservable<MapMarker>|null = null;
  private detailsPaneOpened = false;
  private detailsPinMarker: ui.Unobservable<L.Marker>|null = null;

  private markerComponents = MARKER_COMPONENTS;
  private markerGroups: Map<string, MapMarkerGroup> = new Map();

  private searching = false;
  private searchQuery = '';
  private searchThrottler!: () => void;
  private searchLastSearchFailed = false;
  private searchResults: ObjectMinData[] = [];
  private searchResultMarkers: ui.Unobservable<MapMarker>[] = [];
  private searchGroups: SearchResultGroup[] = [];
  private searchPresets = SEARCH_PRESETS;
  private searchExcludedSets: SearchExcludeSet[] = [];
  private readonly MAX_SEARCH_RESULT_COUNT = 2000;

  private tempObjMarker: ui.Unobservable<MapMarker>|null = null;

  setViewFromRoute(route: any) {
    const x = parseFloat(route.params.x);
    const z = parseFloat(route.params.z);
    if (isNaN(x) || isNaN(z)) {
      this.$router.replace({ name: 'map' });
      return;
    }

    let zoom = parseInt(route.params.zoom);
    if (isNaN(zoom))
      zoom = 3;

    this.map.setView([x, z], zoom);
  }
  updateRoute() {
    this.updatingRoute = true;
    // @ts-ignore
    this.$router.replace({ name: 'map', params: {
      x: this.map.center[0],
      z: this.map.center[1],
      zoom: this.map.m.getZoom(),
    }});
    this.updatingRoute = false;
  }

  initMapRouteIntegration() {
    this.setViewFromRoute(this.$route);
    this.map.zoom = this.map.m.getZoom();
    this.map.center = this.map.toXZ(this.map.m.getCenter());
    this.map.registerMoveEndCb(() => this.updateRoute());
    this.map.registerZoomEndCb(() => this.updateRoute());
    this.updateRoute();
  }

  initMarkers() {
    this.map.registerZoomCb(() => this.updateMarkers());
    this.updateMarkers();
  }

  updateMarkers() {
    const info = MapMgr.getInstance().getInfoMainField();
    for (const type of Object.keys(info.markers)) {
      if (!Settings.getInstance().shownGroups.has(type)) {
        // Group exists and needs to be removed.
        if (this.markerGroups.has(type)) {
          this.markerGroups.get(type)!.destroy();
          this.markerGroups.delete(type);
        }
        continue;
      }

      // Nothing to do -- the group already exists.
      if (this.markerGroups.has(type))
        continue;

      const markers: any[] = info.markers[type];
      const component = MARKER_COMPONENTS[type];
      const group = new MapMarkerGroup(
        markers.map((m: any) => new (component.cl)(this.map, m)),
        valueOrDefault(component.preloadPad, 1.0),
        valueOrDefault(component.enableUpdates, true));
      this.markerGroups.set(type, group);
      group.addToMap(this.map.m);
    }

    for (const group of this.markerGroups.values())
      group.update();
  }

  initSidebar() {
    this.sidebar = L.control.sidebar({
      closeButton: true,
      container: 'sidebar',
      position: 'left',
    })
    this.sidebar.addTo(this.map.m);
    const el = (document.getElementById('sidebar-content'))!;
    const origOpen = this.sidebar.open;
    // Fires before switching the active pane.
    this.sidebar.open = (id: string) => {
      this.sidebarPaneScrollPos.set(this.sidebarActivePane, el.scrollTop);
      return origOpen.apply(this.sidebar, [id]);
    };
    // Fires after switching the active pane.
    this.sidebar.on('content', (e) => {
      // @ts-ignore
      const id: string = e.id;
      this.sidebarActivePane = id;
      el.scrollTop = this.sidebarPaneScrollPos.get(this.sidebarActivePane) || 0;
    });
  }

  closeSidebar() {
    this.sidebar.close();
  }

  switchPane(pane: string) {
    this.sidebar.open(pane);
  }

  initDrawTools() {
    const drawLayer = new L.GeoJSON();
    const savedData = Settings.getInstance().drawLayerGeojson;
    if (savedData)
      drawLayer.addData(JSON.parse(savedData));
    drawLayer.addTo(this.map.m);
    const options = {
      position: 'topleft',
      draw: {
        circlemarker: false,
        rectangle: { showRadius: false },
      },
      edit: {
        featureGroup: drawLayer,
      },
    };
    // @ts-ignore
    this.drawControl = new L.Control.Draw(options);
    this.map.m.on({
      'draw:created': (e: any) => {
        drawLayer.addLayer(e.layer);
      },
    });
    Settings.getInstance().registerBeforeSaveCallback(() => {
      Settings.getInstance().drawLayerGeojson = JSON.stringify(drawLayer.toGeoJSON());
    });
  }

  toggleDraw() {
    this.sidebar.close();
    if (this.drawControlEnabled)
      this.drawControl.remove();
    else
      this.drawControl.addTo(this.map.m);
    this.drawControlEnabled = !this.drawControlEnabled;
  }

  showGreatPlateauBarrier() {
    if (!this.greatPlateauBarrierShown) {
      const RESPAWN_POS: Point = [-1021.7286376953125, 1792.6009521484375];
      const respawnPosMarker = new MapMarkers.MapMarkerPlateauRespawnPos(this.map, RESPAWN_POS);
      const topLeft = this.map.fromXZ([-1600, 1400]);
      const bottomRight = this.map.fromXZ([-350, 2400]);
      const rect = L.rectangle(L.latLngBounds(topLeft, bottomRight), {
        fill: false,
        stroke: true,
        color: '#c50000',
        weight: 2,
        // @ts-ignore
        contextmenu: true,
        contextmenuItems: [{
          text: 'Hide barrier and respawn point',
          callback: () => {
            respawnPosMarker.getMarker().remove();
            rect.remove();
            this.greatPlateauBarrierShown = false;
          },
        }],
      });
      rect.addTo(this.map.m);
      respawnPosMarker.getMarker().addTo(this.map.m);
      this.greatPlateauBarrierShown = true;
    }
    this.map.setView([-965, 1875], 5);
  }

  gotoOnSubmit(xz: Point) {
    this.map.setView(xz);
    if (this.previousGotoMarker)
      this.previousGotoMarker.remove();
    this.previousGotoMarker = L.marker(this.map.fromXZ(xz), {
      // @ts-ignore
      contextmenu: true,
      contextmenuItems: [{
        text: 'Hide',
        callback: () => { this.previousGotoMarker!.remove(); this.previousGotoMarker = null; },
      }],
    }).addTo(this.map.m);
  }

  initMarkerDetails() {
    this.map.registerMarkerSelectedCb((marker: MapMarker) => {
      this.openMarkerDetails(getMarkerDetailsComponent(marker), marker);
    });
    this.map.m.on({'click': () => this.closeMarkerDetails()});
  }

  openMarkerDetails(component: string, marker: MapMarker, zoom = -1) {
    this.closeMarkerDetails(true);
    this.detailsMarker = new ui.Unobservable(marker);
    this.detailsComponent = component;
    this.switchPane('spane-details');
    this.detailsPaneOpened = true;
    this.detailsPinMarker = new ui.Unobservable(L.marker(marker.getMarker().getLatLng(), {
      pane: 'front',
    }).addTo(this.map.m));
    if (zoom == -1)
      this.map.m.panTo(marker.getMarker().getLatLng());
    else
      this.map.m.setView(marker.getMarker().getLatLng(), zoom);
  }

  closeMarkerDetails(forOpen=false) {
    if (!this.detailsPaneOpened)
      return;
    this.detailsComponent = '';
    this.detailsMarker = null;
    if (!forOpen) {
      this.sidebar.close();
    }
    if (this.detailsPinMarker) {
      this.detailsPinMarker.data.remove();
      this.detailsPinMarker = null;
    }
    this.detailsPaneOpened = false;
  }

  initSearch() {
    this.searchThrottler = debounce(() => this.search(), 200);

    Settings.getInstance().registerCallback(() => {
      for (const group of this.searchGroups)
        group.update(SearchResultUpdateMode.UpdateStyle, this.searchExcludedSets);
    });
    this.map.registerZoomCb(() => {
      for (const group of this.searchGroups)
        group.update(0, this.searchExcludedSets);
    });
  }

  searchGetQuery() {
    let query = this.searchQuery;
    if (/^0x[0-9A-Fa-f]{6}/g.test(query))
      query = parseInt(query, 16).toString(10);
    return query;
  }

  searchJumpToResult(idx: number) {
    const marker = this.searchResultMarkers[idx];
    this.openMarkerDetails(getMarkerDetailsComponent(marker.data), marker.data, 6);
  }

  searchOnInput() {
    this.searching = true;
    this.searchThrottler();
  }

  searchOnAdd() {
    this.searchAddGroup(this.searchGetQuery());
    this.searchQuery = '';
    this.search();
  }

  async searchOnExclude() {
    const query = this.searchGetQuery();
    const set = new SearchExcludeSet(query, query);
    this.searchExcludedSets.push(set);
    await set.init();
    this.searchQuery = '';
    this.search();
    for (const group of this.searchGroups)
      group.update(SearchResultUpdateMode.UpdateVisibility, this.searchExcludedSets);
  }

  async searchAddGroup(query: string, label?: string) {
    if (this.searchGroups.some(g => g.query == query))
      return;

    const group = new SearchResultGroup(query, label || query);
    await group.init(this.map);
    group.update(SearchResultUpdateMode.UpdateStyle | SearchResultUpdateMode.UpdateVisibility, this.searchExcludedSets);
    this.searchGroups.push(group);
  }

  searchViewGroup(idx: number) {
    const group = this.searchGroups[idx];
    this.searchQuery = group.query;
    this.search();
  }

  searchRemoveGroup(idx: number) {
    const group = this.searchGroups[idx];
    group.remove();
    this.searchGroups.splice(idx, 1);
  }

  searchRemoveExcludeSet(idx: number) {
    this.searchExcludedSets.splice(idx, 1);
    for (const group of this.searchGroups)
      group.update(SearchResultUpdateMode.UpdateVisibility, this.searchExcludedSets);
  }

  async search() {
    this.searching = true;
    this.searchResultMarkers.forEach(m => m.data.getMarker().remove());
    this.searchResultMarkers = [];

    const query = this.searchGetQuery();
    try {
      this.searchResults = await MapMgr.getInstance().getObjs('MainField', '', query, false, this.MAX_SEARCH_RESULT_COUNT);
      this.searchLastSearchFailed = false;
    } catch (e) {
      this.searchResults = [];
      this.searchLastSearchFailed = true;
    }

    for (const result of this.searchResults) {
      const marker = new ui.Unobservable(new MapMarkers.MapMarkerSearchResult(this.map, result));
      this.searchResultMarkers.push(marker);
      marker.data.getMarker().addTo(this.map.m);
    }

    this.searching = false;
  }

  initContextMenu() {
    this.map.m.on(SHOW_ALL_OBJS_FOR_MAP_UNIT_EVENT, (e) => {
      // @ts-ignore
      const latlng: L.LatLng = e.latlng;
      const xz = this.map.toXZ(latlng);
      if (!map.isValidPoint(xz))
        return;
      this.searchAddGroup(`map:"MainField/${map.pointToMapUnit(xz)}"`);
    });
  }

  initEvents() {
    this.$on('AppMap:switch-pane', (pane: string) => {
      this.switchPane(pane);
    });

    this.$on('AppMap:open-obj', async (obj: ObjectData) => {
      if (this.tempObjMarker)
        this.tempObjMarker.data.getMarker().remove();
      this.tempObjMarker = new ui.Unobservable(new MapMarkers.MapMarkerObj(this.map, obj, '#e02500', '#ff2a00'));
      this.tempObjMarker.data.getMarker().addTo(this.map.m);
      this.openMarkerDetails(getMarkerDetailsComponent(this.tempObjMarker.data), this.tempObjMarker.data);
    });
    this.map.m.on('click', () => {
      if (this.tempObjMarker)
        this.tempObjMarker.data.getMarker().remove();
    });
  }

  mounted() {
    this.map = new MapBase('lmap');
    this.map.registerZoomChangeCb((zoom) => this.zoom = zoom);
    this.initMapRouteIntegration();
    this.initMarkers();
    this.initSidebar();
    this.initDrawTools();
    this.initMarkerDetails();
    this.initSearch();
    this.initContextMenu();
    this.initEvents();
  }

  beforeDestroy() {
    this.map.m.remove();
  }

  beforeRouteUpdate(to: any, from: any, next: any) {
    if (!this.updatingRoute)
      this.setViewFromRoute(to);
    next();
  }
}