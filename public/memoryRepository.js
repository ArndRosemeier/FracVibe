// In-memory repository for fractal locations (session only)
export class FractalMemoryRepository {
  constructor() {
    this.locations = [];
    this.counter = 1;
  }
  save(location) {
    if (!location.name) {
      location.name = `Location ${this.counter++}`;
    }
    if (!location.timestamp) {
      location.timestamp = Date.now();
    }
    this.locations.push(location);
  }
  getAll(sortBy = 'timestamp') {
    const sorted = [...this.locations];
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      sorted.sort((a, b) => b.timestamp - a.timestamp);
    }
    return sorted;
  }
  get(id) {
    return this.locations.find(loc => loc.id === id);
  }
  remove(id) {
    this.locations = this.locations.filter(loc => loc.id !== id);
  }
  clear() {
    this.locations = [];
    this.counter = 1;
  }
}
