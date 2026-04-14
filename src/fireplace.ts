import {Service, PlatformAccessory, CharacteristicValue} from 'homebridge';
import {IntellifirePlatform} from './platform.js';
import {clearTimeout} from 'timers';

export class Fireplace {
  private readonly service: Service;
  private readonly pilotService: Service | undefined;
  private readonly sensor: Service | undefined;
  private readonly fan: Service | undefined;
  private readonly lightService: Service | undefined;
  private readonly fanSpeedService: Service | undefined;
  private readonly thermostatService: Service | undefined;
  private readonly coldClimateService: Service | undefined;
  private readonly timerService: Service | undefined;

  private heightTimer!: NodeJS.Timeout;
  private pollTimer!: NodeJS.Timeout;
  private lightTimer!: NodeJS.Timeout;
  private fanSpeedTimer!: NodeJS.Timeout;

  private states = {
    on: false,
    ackOn: false,
    height: 2,
    pilot: false,
    light: 0,
    lastLight: 1,
    fanSpeed: 0,
    lastFanSpeed: 1,
    temperature: 20,
    targetTemperature: 20,
    coldClimate: false,
    timerOn: false,
  };

  constructor(
    private readonly platform: IntellifirePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    this.platform.log.info(`Creating fireplace for device: ${JSON.stringify(this.device())}`);

    this.platform.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
      }
      if (this.heightTimer) {
        clearTimeout(this.heightTimer);
      }
      if (this.lightTimer) {
        clearTimeout(this.lightTimer);
      }
      if (this.fanSpeedTimer) {
        clearTimeout(this.fanSpeedTimer);
      }
    });

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hearth and Home')
      .setCharacteristic(this.platform.Characteristic.Model, this.device().brand)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device().serial);

    // Power switch
    this.service = this.accessory.getService(this.platform.Service.Switch) || this.accessory.addService(this.platform.Service.Switch);
    this.setName(this.service, 'Power');
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Pilot mode switch
    if (this.platform.config.hidePilot) {
      const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'pilot-mode');
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.pilotService = undefined;
    } else {
      this.pilotService = this.accessory.getServiceById(this.platform.Service.Switch, 'pilot-mode') ||
        this.accessory.addService(this.platform.Service.Switch, 'Pilot Mode', 'pilot-mode');
      this.setName(this.pilotService, 'Pilot Mode');
      this.pilotService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setPilot.bind(this))
        .onGet(this.getPilot.bind(this));
    }

    // Fireplace valve contact sensor
    if (this.platform.config.hideSensor) {
      const existing = this.accessory.getService(this.platform.Service.ContactSensor);
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.sensor = undefined;
    } else {
      this.sensor = this.accessory.getService(this.platform.Service.ContactSensor) ||
        this.accessory.addService(this.platform.Service.ContactSensor);
      this.setName(this.sensor, 'Fireplace Valve');
    }

    // Flame height (fan or dimmer)
    if (this.platform.config.hideBlower) {
      const existingFan = this.accessory.getService(this.platform.Service.Fan);
      if (existingFan) {
        this.accessory.removeService(existingFan);
      }
      const existingLight = this.accessory.getService(this.platform.Service.Lightbulb);
      if (existingLight) {
        this.accessory.removeService(existingLight);
      }
      this.fan = undefined;
    } else if (this.platform.config.flameHeightAs === 'dimmer') {
      const existingFan = this.accessory.getService(this.platform.Service.Fan);
      if (existingFan) {
        this.accessory.removeService(existingFan);
      }
      this.fan = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);
      this.setName(this.fan, 'Flame Height');
      this.fan.getCharacteristic(this.platform.Characteristic.Brightness)
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onSet(this.setHeight.bind(this));
    } else {
      const existingLight = this.accessory.getService(this.platform.Service.Lightbulb);
      if (existingLight) {
        this.accessory.removeService(existingLight);
      }
      this.fan = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);
      this.setName(this.fan, 'Flame Height');
      this.fan.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 4, minStep: 1 })
        .onSet(this.setHeight.bind(this));
    }

    // Ambient light (levels 0-3)
    if (this.platform.config.hideLight) {
      const existing = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'ambient-light');
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.lightService = undefined;
    } else {
      this.lightService = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'ambient-light') ||
        this.accessory.addService(this.platform.Service.Lightbulb, 'Ambient Light', 'ambient-light');
      this.setName(this.lightService, 'Ambient Light');
      this.lightService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLightOn.bind(this))
        .onGet(this.getLightOn.bind(this));
      this.lightService.getCharacteristic(this.platform.Characteristic.Brightness)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet(this.setLightBrightness.bind(this))
        .onGet(this.getLightBrightness.bind(this));
    }

    // Blower fan speed (levels 0-6)
    if (this.platform.config.hideFanSpeed) {
      const existing = this.accessory.getServiceById(this.platform.Service.Fan, 'fan-speed');
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.fanSpeedService = undefined;
    } else {
      this.fanSpeedService = this.accessory.getServiceById(this.platform.Service.Fan, 'fan-speed') ||
        this.accessory.addService(this.platform.Service.Fan, 'Fan Speed', 'fan-speed');
      this.setName(this.fanSpeedService, 'Fan Speed');
      this.fanSpeedService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setFanSpeedOn.bind(this))
        .onGet(this.getFanSpeedOn.bind(this));
      this.fanSpeedService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet(this.setFanSpeedValue.bind(this))
        .onGet(this.getFanSpeedValue.bind(this));
    }

    // Thermostat
    if (this.platform.config.hideThermostat) {
      const existing = this.accessory.getService(this.platform.Service.Thermostat);
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.thermostatService = undefined;
    } else {
      this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) ||
        this.accessory.addService(this.platform.Service.Thermostat);
      this.setName(this.thermostatService, 'Thermostat');
      this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
        .onGet(this.getThermostatCurrentState.bind(this));
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .setProps({ validValues: [0, 1] })
        .onSet(this.setThermostatTargetState.bind(this))
        .onGet(this.getThermostatTargetState.bind(this));
      this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .setProps({ minValue: 0, maxValue: 37, minStep: 0.5 })  // HomeKit always uses °C internally
        .onSet(this.setTargetTemperature.bind(this))
        .onGet(this.getTargetTemperature.bind(this));
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
        .setValue(this.platform.config.temperatureUnit === 'C' ? 0 : 1);  // 0 = Celsius, 1 = Fahrenheit
    }

    // Cold climate mode switch
    if (this.platform.config.hideColdClimate) {
      const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'cold-climate');
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.coldClimateService = undefined;
    } else {
      this.coldClimateService = this.accessory.getServiceById(this.platform.Service.Switch, 'cold-climate') ||
        this.accessory.addService(this.platform.Service.Switch, 'Cold Climate Mode', 'cold-climate');
      this.setName(this.coldClimateService, 'Cold Climate Mode');
      this.coldClimateService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setColdClimate.bind(this))
        .onGet(this.getColdClimate.bind(this));
    }

    // Sleep timer switch
    if (this.platform.config.hideTimer) {
      const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'timer');
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.timerService = undefined;
    } else {
      this.timerService = this.accessory.getServiceById(this.platform.Service.Switch, 'timer') ||
        this.accessory.addService(this.platform.Service.Switch, 'Sleep Timer', 'timer');
      this.setName(this.timerService, 'Sleep Timer');
      this.timerService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setTimer.bind(this))
        .onGet(this.getTimer.bind(this));
    }

    this.platform.cloud.on('connected', () => {
      this.platform.cloud.status(this.device()).then(this.handleResponse.bind(this));
    });

    this.poll();
  }

  device() {
    return this.accessory.context.device;
  }

  setName(service: Service, name: string) {
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
  }


  handleResponse(response) {
    if (response.ok) {
      response.json().then(data => {
        this.platform.log.debug(`Status response: ${JSON.stringify(data)}`);
        this.updateStatus(
          data.power === '1',
          Number(data.height),
          data.pilot === '1',
          data.light != null ? Number(data.light) : this.states.light,
          data.fanspeed != null ? Number(data.fanspeed) : this.states.fanSpeed,
          data.temperature != null ? Number(data.temperature) : this.states.temperature,
          data.setpoint != null && Number(data.setpoint) > 0 ? Number(data.setpoint) / 100 : this.states.targetTemperature,
          data.cold_climate_mode === '1',
          data.timer === '1',
        );
        this.platform.log.info(`[${this.device().name}] ${JSON.stringify(this.states)}`);
      });
    } else {
      this.platform.log.info(`[${this.device().name}] ${JSON.stringify(this.states)}`);
    }
  }

  api() {
    return this.platform.cloud.connected ? this.platform.cloud : this.platform.local;
  }

  connected() {
    return this.platform.cloud.connected;
  }

  poll() {
    this.api().poll(this.device())
      .then(this.handleResponse.bind(this))
      .catch(err => {
        this.platform.log.info(err.message);
      })
      .finally(() => {
        this.pollTimer = setTimeout(this.poll.bind(this), this.connected() ? 0 : 5000);
      });
  }

  updateStatus(
    power: boolean,
    height: number,
    pilot: boolean,
    light: number,
    fanSpeed: number,
    temperature: number,
    targetTemperature: number,
    coldClimate: boolean,
    timerOn: boolean,
  ) {
    if (power !== this.states.ackOn) {
      this.sensor?.getCharacteristic(this.platform.Characteristic.ContactSensorState).updateValue(power);
    }

    this.states.on = power;
    this.states.ackOn = power;
    this.states.height = this.states.on ? height : 0;
    this.states.pilot = pilot;
    this.states.temperature = temperature;
    this.states.targetTemperature = targetTemperature;
    this.states.light = light;
    if (light > 0) {
      this.states.lastLight = light;
    }
    this.states.fanSpeed = fanSpeed;
    if (fanSpeed > 0) {
      this.states.lastFanSpeed = fanSpeed;
    }
    this.states.coldClimate = coldClimate;
    this.states.timerOn = timerOn;


    this.service.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.on);
    this.pilotService?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.pilot);

    if (this.fan) {
      this.fan.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.on);
      if (this.platform.config.flameHeightAs === 'dimmer') {
        this.fan.getCharacteristic(this.platform.Characteristic.Brightness).updateValue(this.states.height * 25);
      } else {
        this.fan.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(this.states.height);
      }
    }

    if (this.thermostatService) {
      this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).updateValue(power ? 1 : 0);
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).updateValue(power ? 1 : 0);
      this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(this.states.temperature);
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature).updateValue(this.states.targetTemperature);
    }

    if (this.lightService) {
      this.lightService.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.light > 0);
      this.lightService.getCharacteristic(this.platform.Characteristic.Brightness).updateValue(Math.round((this.states.light / 3) * 100));
    }

    if (this.fanSpeedService) {
      this.fanSpeedService.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.fanSpeed > 0);
      this.fanSpeedService.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(Math.round((this.states.fanSpeed / 6) * 100));
    }

    this.coldClimateService?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.coldClimate);
    this.timerService?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.timerOn);
  }

  post(command: string, value: string) {
    this.api().post(this.device(), command, value);
  }

  // --- Power ---

  sendPowerCommand() {
    this.post('power', this.states.on ? '1' : '0');
  }

  setOn(value: CharacteristicValue) {
    if (value as boolean !== this.states.on) {
      this.states.on = value as boolean;
      if (this.states.on) {
        this.states.pilot = false;
        this.pilotService?.getCharacteristic(this.platform.Characteristic.On).updateValue(false);
        setImmediate(this.sendPilotCommand.bind(this));
      }
      setImmediate(this.sendPowerCommand.bind(this));
    }
    this.fan?.getCharacteristic(this.platform.Characteristic.On).updateValue(this.states.on);
    if (this.thermostatService) {
      this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).updateValue(this.states.on ? 1 : 0);
      this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).updateValue(this.states.on ? 1 : 0);
    }
  }

  getOn(): CharacteristicValue {
    return this.states.on;
  }

  // --- Pilot ---

  sendPilotCommand() {
    this.post('pilot', this.states.pilot ? '1' : '0');
  }

  setPilot(value: CharacteristicValue) {
    if (value as boolean !== this.states.pilot) {
      this.states.pilot = value as boolean;
      if (this.states.pilot) {
        this.states.on = false;
        this.service.getCharacteristic(this.platform.Characteristic.On).updateValue(false);
        this.fan?.getCharacteristic(this.platform.Characteristic.On).updateValue(false);
        if (this.thermostatService) {
          this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).updateValue(0);
          this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).updateValue(0);
        }
        setImmediate(this.sendPowerCommand.bind(this));
      }
      setImmediate(this.sendPilotCommand.bind(this));
    }
  }

  getPilot(): CharacteristicValue {
    return this.states.pilot;
  }

  // --- Flame height ---

  sendHeightCommand() {
    this.post('height', this.states.height.toString());
  }

  setHeight(value: CharacteristicValue) {
    const height = this.platform.config.flameHeightAs === 'dimmer'
      ? Math.round((value as number) / 25)
      : value as number;
    if (height !== this.states.height) {
      this.states.height = height;
      if (this.heightTimer) {
        clearTimeout(this.heightTimer);
      }
      this.heightTimer = setTimeout(this.sendHeightCommand.bind(this), 2000);
    }
  }

  // --- Ambient light ---

  sendLightCommand() {
    this.post('light', this.states.light.toString());
  }

  setLightOn(value: CharacteristicValue) {
    const on = value as boolean;
    this.states.light = on ? (this.states.lastLight > 0 ? this.states.lastLight : 1) : 0;
    this.lightService?.getCharacteristic(this.platform.Characteristic.Brightness)
      .updateValue(Math.round((this.states.light / 3) * 100));
    if (this.lightTimer) {
      clearTimeout(this.lightTimer);
    }
    this.lightTimer = setTimeout(this.sendLightCommand.bind(this), 500);
  }

  getLightOn(): CharacteristicValue {
    return this.states.light > 0;
  }

  setLightBrightness(value: CharacteristicValue) {
    const level = Math.round(((value as number) / 100) * 3);
    if (level !== this.states.light) {
      this.states.light = level;
      if (level > 0) {
        this.states.lastLight = level;
      }
      this.lightService?.getCharacteristic(this.platform.Characteristic.On).updateValue(level > 0);
      if (this.lightTimer) {
        clearTimeout(this.lightTimer);
      }
      this.lightTimer = setTimeout(this.sendLightCommand.bind(this), 500);
    }
  }

  getLightBrightness(): CharacteristicValue {
    return Math.round((this.states.light / 3) * 100);
  }

  // --- Blower fan speed ---

  sendFanSpeedCommand() {
    this.post('fanspeed', this.states.fanSpeed.toString());
  }

  setFanSpeedOn(value: CharacteristicValue) {
    const on = value as boolean;
    this.states.fanSpeed = on ? (this.states.lastFanSpeed > 0 ? this.states.lastFanSpeed : 1) : 0;
    this.fanSpeedService?.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .updateValue(Math.round((this.states.fanSpeed / 6) * 100));
    if (this.fanSpeedTimer) {
      clearTimeout(this.fanSpeedTimer);
    }
    this.fanSpeedTimer = setTimeout(this.sendFanSpeedCommand.bind(this), 500);
  }

  getFanSpeedOn(): CharacteristicValue {
    return this.states.fanSpeed > 0;
  }

  setFanSpeedValue(value: CharacteristicValue) {
    const speed = Math.round(((value as number) / 100) * 6);
    if (speed !== this.states.fanSpeed) {
      this.states.fanSpeed = speed;
      if (speed > 0) {
        this.states.lastFanSpeed = speed;
      }
      this.fanSpeedService?.getCharacteristic(this.platform.Characteristic.On).updateValue(speed > 0);
      if (this.fanSpeedTimer) {
        clearTimeout(this.fanSpeedTimer);
      }
      this.fanSpeedTimer = setTimeout(this.sendFanSpeedCommand.bind(this), 500);
    }
  }

  getFanSpeedValue(): CharacteristicValue {
    return Math.round((this.states.fanSpeed / 6) * 100);
  }

  // --- Thermostat ---

  sendThermostatCommand() {
    this.post('setpoint', Math.round(this.states.targetTemperature * 100).toString());
  }

  setThermostatTargetState(value: CharacteristicValue) {
    const heat = (value as number) === 1;
    if (heat !== this.states.on) {
      this.states.on = heat;
      this.service.getCharacteristic(this.platform.Characteristic.On).updateValue(heat);
      this.fan?.getCharacteristic(this.platform.Characteristic.On).updateValue(heat);
      if (heat) {
        this.states.pilot = false;
        this.pilotService?.getCharacteristic(this.platform.Characteristic.On).updateValue(false);
        setImmediate(this.sendPilotCommand.bind(this));
      }
      setImmediate(this.sendPowerCommand.bind(this));
    }
  }

  getThermostatTargetState(): CharacteristicValue {
    return this.states.on ? 1 : 0;
  }

  getThermostatCurrentState(): CharacteristicValue {
    return this.states.on ? 1 : 0;
  }

  setTargetTemperature(value: CharacteristicValue) {
    this.states.targetTemperature = value as number;
    setImmediate(this.sendThermostatCommand.bind(this));
  }

  getTargetTemperature(): CharacteristicValue {
    return this.states.targetTemperature;
  }

  getCurrentTemperature(): CharacteristicValue {
    return this.states.temperature;
  }

  // --- Cold climate ---

  sendColdClimateCommand() {
    this.post('cold_climate_mode', this.states.coldClimate ? '1' : '0');
  }

  setColdClimate(value: CharacteristicValue) {
    if (value as boolean !== this.states.coldClimate) {
      this.states.coldClimate = value as boolean;
      setImmediate(this.sendColdClimateCommand.bind(this));
    }
  }

  getColdClimate(): CharacteristicValue {
    return this.states.coldClimate;
  }

  // --- Sleep timer ---

  sendTimerCommand() {
    this.post('timer', this.states.timerOn ? '1' : '0');
  }

  setTimer(value: CharacteristicValue) {
    if (value as boolean !== this.states.timerOn) {
      this.states.timerOn = value as boolean;
      setImmediate(this.sendTimerCommand.bind(this));
    }
  }

  getTimer(): CharacteristicValue {
    return this.states.timerOn;
  }

}
