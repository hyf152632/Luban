import isEqual from 'lodash/isEqual';
import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';
import * as THREE from 'three';
import TWEEN from '@tweenjs/tween.js';
import pubsub from 'pubsub-js';
import colornames from 'colornames';

import { Button } from '@trendmicro/react-buttons';
import Canvas from '../../components/SMCanvas';
import styles from './index.styl';
import { controller } from '../../lib/controller';
import {
    CONNECTION_TYPE_SERIAL,
    MACHINE_HEAD_TYPE,
    MARLIN,
    PROTOCOL_TEXT, WORKFLOW_STATUS_IDLE, WORKFLOW_STATUS_PAUSED, WORKFLOW_STATUS_RUNNING,
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_PAUSED,
    WORKFLOW_STATE_RUNNING, WORKFLOW_STATUS_UNKNOWN, IMAGE_WIFI_ERROR
} from '../../constants';
import { ensureRange } from '../../lib/numeric-utils';
import TextSprite from '../../components/three-extensions/TextSprite';
import TargetPoint from '../../components/three-extensions/TargetPoint';
import { actions } from '../../flux/workspace';
import { actions as machineActions } from '../../flux/machine';
import PrintablePlate from '../CncLaserShared/PrintablePlate';

import GCodeRenderer from './GCodeRenderer';
import { loadTexture } from './helpers';
import Loading from './Loading';
import Rendering from './Rendering';
import ToolHead from './ToolHead';
import WorkflowControl from './WorkflowControl';
import SecondaryToolbar from '../CanvasToolbar/SecondaryToolbar';
import Modal from '../../components/Modal';
import i18n from '../../lib/i18n';
import modalSmallHOC from '../../components/Modal/modal-small';


class Visualizer extends Component {
    static propTypes = {
        // redux
        size: PropTypes.object.isRequired,
        enclosure: PropTypes.bool.isRequired,
        enclosureDoor: PropTypes.bool.isRequired,
        uploadState: PropTypes.string.isRequired,
        headType: PropTypes.string,
        isConnected: PropTypes.bool.isRequired,
        connectionType: PropTypes.string.isRequired,
        workflowStatus: PropTypes.string.isRequired,
        gcodeList: PropTypes.array.isRequired,
        addGcode: PropTypes.func.isRequired,
        uploadGcodeFile: PropTypes.func.isRequired,
        clearGcode: PropTypes.func.isRequired,
        loadGcode: PropTypes.func.isRequired,
        unloadGcode: PropTypes.func.isRequired,

        startServerGcode: PropTypes.func.isRequired,
        pauseServerGcode: PropTypes.func.isRequired,
        resumeServerGcode: PropTypes.func.isRequired,
        stopServerGcode: PropTypes.func.isRequired,

        gcodePrintingInfo: PropTypes.shape({
            sent: PropTypes.number
        }),
        workPosition: PropTypes.object
    };

    printableArea = null;

    modelGroup = new THREE.Group();

    canvas = React.createRef();

    gcodeFilenameObject = null;

    targetPoint = null;

    toolhead = null;

    toolheadRotationAnimation = null;

    pubsubTokens = [];

    gcodeRenderer = null;

    pauseStatus = {
        headStatus: false,
        headPower: 0
    };

    pause3dpStatus = {
        pausing: false,
        pos: null
    };

    state = {
        coordinateVisible: true,
        toolheadVisible: true,
        gcodeFilenameVisible: true,
        port: controller.port,
        controller: {
            type: controller.type,
            state: controller.state,
            settings: controller.settings
        },
        workflowState: controller.workflowState,
        workPosition: {
            x: '0.000',
            y: '0.000',
            z: '0.000',
            e: '0.000'
        },
        gcode: {
            renderState: 'idle', // idle, rendering, rendered
            ready: false,

            // Updates by the "sender:status" event
            name: '',
            size: 0,
            total: 0,
            sent: 0,
            received: 0
        },
        showEnclosureDoorWarn: false
    };

    controllerEvents = {
        'serialport:open': (options) => {
            const { port } = options;
            this.stopToolheadRotationAnimation();
            this.updateWorkPositionToZero();
            this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();

            this.setState({ port }, () => {
                this.loadGcode();
            });
        },
        'serialport:close': (options) => {
            const { dataSource } = options;
            if (dataSource !== PROTOCOL_TEXT) {
                return;
            }
            // reset state related to port and controller
            this.stopToolheadRotationAnimation();
            this.updateWorkPositionToZero();
            this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();

            this.setState(() => ({
                port: controller.port,
                controller: {
                    type: controller.type,
                    state: controller.state
                },
                workflowState: controller.workflowState
            }));

            this.unloadGcode();
        },
        // 'sender:status': (data, dataSource) => {
        'sender:status': (options) => {
            const { data, dataSource } = options;
            if (dataSource !== PROTOCOL_TEXT) {
                return;
            }
            const { name, size, total, sent, received } = data;
            this.setState({
                gcode: {
                    ...this.state.gcode,
                    name,
                    size,
                    total,
                    sent,
                    received
                }
            });
            this.gcodeRenderer && this.gcodeRenderer.setFrameIndex(sent);
            this.renderScene();
        },
        'workflow:state': (options) => {
            const { dataSource, workflowState } = options;
            if (dataSource !== PROTOCOL_TEXT) {
                return;
            }
            if (this.state.workflowState !== workflowState) {
                this.setState({ workflowState });
                switch (workflowState) {
                    case WORKFLOW_STATE_IDLE:
                        this.stopToolheadRotationAnimation();
                        this.updateWorkPositionToZero();
                        this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();
                        break;
                    case WORKFLOW_STATE_RUNNING:
                        this.startToolheadRotationAnimation();
                        break;
                    case WORKFLOW_STATE_PAUSED:
                        this.stopToolheadRotationAnimation();
                        break;
                    default:
                        break;
                }
            }
        },
        // FIXME
        'Marlin:state': (options) => {
            const { state, dataSource } = options;
            if (dataSource !== PROTOCOL_TEXT) {
                return;
            }
            const { pos } = state;
            this.setState({
                controller: {
                    type: MARLIN,
                    ...this.state.controller,
                    state
                }
            });
            if (this.state.workflowState === WORKFLOW_STATE_RUNNING) {
                this.updateWorkPosition(pos);
            }
        },
        'Marlin:settings': (options) => {
            const { settings, dataSource } = options;
            if (dataSource !== PROTOCOL_TEXT) {
                return;
            }
            this.setState({
                controller: {
                    type: MARLIN,
                    ...this.state.controller,
                    settings
                }
            });
        }
    };

    actions = {
        isCNC: () => {
            return (this.props.headType === MACHINE_HEAD_TYPE.CNC.value);
        },
        is3DP: () => {
            return (this.props.headType === MACHINE_HEAD_TYPE['3DP'].value);
        },
        isLaser: () => {
            return (this.props.headType === MACHINE_HEAD_TYPE.LASER.value);
        },
        handleRun: () => {
            const { enclosure, enclosureDoor } = this.props;
            if (!this.actions.is3DP() && enclosure && !enclosureDoor) {
                this.actions.openModal();
                return;
            }
            const { connectionType } = this.props;
            if (connectionType === CONNECTION_TYPE_SERIAL) {
                const { workflowState } = this.state;

                if (workflowState === WORKFLOW_STATE_IDLE) {
                    controller.command('gcode:start');
                }
                if (workflowState === WORKFLOW_STATE_PAUSED) {
                    if (this.actions.is3DP()) {
                        this.pause3dpStatus.pausing = false;
                        const pos = this.pause3dpStatus.pos;
                        const cmd = `G1 X${pos.x} Y${pos.y} Z${pos.z} F1000\n`;
                        controller.command('gcode', cmd);
                        controller.command('gcode:resume');
                    } else if (this.actions.isLaser()) {
                        if (this.pauseStatus.headStatus) {
                            // resume laser power
                            const powerPercent = ensureRange(this.pauseStatus.headPower, 0, 100);
                            const powerStrength = Math.floor(powerPercent * 255 / 100);
                            if (powerPercent !== 0) {
                                controller.command('gcode', `M3 P${powerPercent} S${powerStrength}`);
                            } else {
                                controller.command('gcode', 'M3');
                            }
                        }

                        controller.command('gcode:resume');
                    } else {
                        if (this.pauseStatus.headStatus) {
                            // resume spindle
                            controller.command('gcode', 'M3');

                            // for CNC machine, resume need to wait >500ms to let the tool head started
                            setTimeout(() => {
                                controller.command('gcode:resume');
                            }, 1000);
                        } else {
                            controller.command('gcode:resume');
                        }
                    }
                }
            } else {
                const { workflowStatus } = this.props;
                if (workflowStatus === WORKFLOW_STATUS_IDLE) {
                    this.props.startServerGcode((err) => {
                        if (err) {
                            if (err.status === 202) {
                                modalSmallHOC({
                                    title: i18n._('Filament Runout Recovery'),
                                    text: i18n._('Filament has run out. Please load the new filament to continue printing.'),
                                    img: IMAGE_WIFI_ERROR
                                });
                            } else {
                                modalSmallHOC({
                                    title: i18n._(`Error ${err.status}`),
                                    text: i18n._('Unable to start the job.'),
                                    img: IMAGE_WIFI_ERROR
                                });
                            }
                        }
                    });
                }
                if (workflowStatus === WORKFLOW_STATUS_PAUSED) {
                    this.props.resumeServerGcode((err) => {
                        if (err) {
                            if (err.status === 202) {
                                modalSmallHOC({
                                    title: i18n._('Filament Runout Recovery'),
                                    text: i18n._('Filament has run out. Please load the new filament to continue printing.'),
                                    img: IMAGE_WIFI_ERROR
                                });
                            } else {
                                modalSmallHOC({
                                    title: i18n._(`Error ${err.status}`),
                                    text: i18n._('Unable to resume the job.'),
                                    img: IMAGE_WIFI_ERROR
                                });
                            }
                        }
                    });
                }
            }
        },
        tryPause: () => {
            // delay 500ms to let buffer executed. and status propagated
            setTimeout(() => {
                if (this.state.gcode.received >= this.state.gcode.sent) {
                    this.pauseStatus = {
                        headStatus: this.state.controller.state.headStatus,
                        headPower: this.state.controller.state.headPower
                    };

                    if (this.pauseStatus.headStatus) {
                        controller.command('gcode', 'M5');
                    }

                    // toolhead has stopped
                    if (this.pause3dpStatus.pausing) {
                        this.pause3dpStatus.pausing = false;
                        const workPosition = this.state.workPosition;
                        this.pause3dpStatus.pos = {
                            x: Number(workPosition.x),
                            y: Number(workPosition.y),
                            z: Number(workPosition.z),
                            e: Number(workPosition.e)
                        };
                        const pos = this.pause3dpStatus.pos;
                        // experience params for retraction: F3000, E->(E-5)
                        const targetE = Math.max(pos.e - 5, 0);
                        const targetZ = Math.min(pos.z + 30, this.props.size.z);
                        const cmd = [
                            `G1 F3000 E${targetE}\n`,
                            `G1 Z${targetZ} F3000\n`,
                            `G1 F100 E${pos.e}\n`
                        ];
                        controller.command('gcode', cmd);
                    }
                } else {
                    this.actions.tryPause();
                }
            }, 50);
        },
        handlePause: () => {
            const { connectionType } = this.props;
            if (connectionType === CONNECTION_TYPE_SERIAL) {
                const { workflowState } = this.state;
                if ([WORKFLOW_STATE_RUNNING].includes(workflowState)) {
                    controller.command('gcode:pause');

                    if (this.actions.is3DP()) {
                        this.pause3dpStatus.pausing = true;
                        this.pause3dpStatus.pos = null;
                    }

                    this.actions.tryPause();
                }
            } else {
                const { workflowStatus } = this.props;
                if (workflowStatus === WORKFLOW_STATUS_RUNNING) {
                    this.props.pauseServerGcode();
                }
            }
        },
        handleStop: () => {
            const { connectionType } = this.props;
            if (connectionType === CONNECTION_TYPE_SERIAL) {
                const { workflowState } = this.state;
                if ([WORKFLOW_STATE_PAUSED].includes(workflowState)) {
                    controller.command('gcode:stop');
                }
            } else {
                const { workflowStatus } = this.props;
                if (workflowStatus !== WORKFLOW_STATUS_IDLE) {
                    this.props.stopServerGcode();
                }
            }
        },
        handleClose: () => {
            // dismiss gcode file name
            this.props.clearGcode();
            this.gcodeFilenameObject && this.modelGroup.remove(this.gcodeFilenameObject);
            const { workflowState } = this.state;
            if ([WORKFLOW_STATE_IDLE].includes(workflowState)) {
                // this.destroyPreviousGcodeObject();
                controller.command('gcode:unload');
                pubsub.publish('gcode:unload'); // Unload the G-code
            }
        },
        handleAddGcode: (name, gcode, renderMethod = 'line') => {
            this.props.clearGcode();
            this.props.addGcode(name, gcode, renderMethod);
        },
        handleUploadGcodeFile: (file) => {
            this.props.uploadGcodeFile(file);
        },
        // canvas
        switchCoordinateVisibility: () => {
            const visible = !this.state.coordinateVisible;
            this.setState(
                { coordinateVisible: visible },
                () => {
                    this.printableArea.changeCoordinateVisibility(visible);
                    this.renderScene();
                }
            );
        },
        autoFocus: () => {
            this.autoFocus();
        },
        zoomIn: () => {
            this.canvas.current.zoomIn();
        },
        zoomOut: () => {
            this.canvas.current.zoomOut();
        },

        switchGCodeFilenameVisibility: () => {
            const visible = !this.state.gcodeFilenameVisible;
            this.setState({ gcodeFilenameVisible: visible });
            this.gcodeFilenameObject && (this.gcodeFilenameObject.visible = visible);
            this.renderScene();
        },
        switchToolheadVisibility: () => {
            const visible = !this.state.toolheadVisible;
            this.toolhead.visible = visible;
            this.setState({ toolheadVisible: visible });
            this.renderScene();
        },
        openModal: () => {
            this.setState({
                showEnclosureDoorWarn: true
            });
        },
        closeModal: () => {
            this.setState({
                showEnclosureDoorWarn: false
            });
        },
        onOpen: () => {
            this.stopToolheadRotationAnimation();
            this.updateWorkPositionToZero();
            this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();
        },
        onClose: () => {
            this.stopToolheadRotationAnimation();
            this.updateWorkPositionToZero();
            this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();
        }
    };

    constructor(props) {
        super(props);

        const size = props.size;
        this.printableArea = new PrintablePlate(size);
    }

    componentDidMount() {
        this.subscribe();
        this.addControllerEvents();
        this.setupToolhead();
        this.setupTargetPoint();
    }

    /**
     * Listen on props updates.
     *
     * When new G-code list received:
     *  - Re-render G-code objects
     *  - Upload G-code to controller
     */
    componentWillReceiveProps(nextProps) {
        if (this.props.gcodeList !== nextProps.gcodeList) {
            // Re-render G-code objects
            this.renderGcodeObjects(nextProps.gcodeList);

            // Upload G-code to controller
            this.loadGcode(nextProps.gcodeList);
        }

        if (!isEqual(nextProps.size, this.props.size)) {
            const size = nextProps.size;
            this.printableArea.updateSize(size);
        }

        if (this.props.workflowStatus !== WORKFLOW_STATUS_IDLE && nextProps.workflowStatus === WORKFLOW_STATUS_IDLE) {
            this.stopToolheadRotationAnimation();
            this.updateWorkPositionToZero();
            this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();
        }
        if (this.props.workflowStatus !== WORKFLOW_STATUS_UNKNOWN && nextProps.workflowStatus === WORKFLOW_STATUS_UNKNOWN) {
            this.stopToolheadRotationAnimation();
            this.updateWorkPositionToZero();
            this.gcodeRenderer && this.gcodeRenderer.resetFrameIndex();
        }
        if (this.props.workflowStatus !== WORKFLOW_STATUS_RUNNING && nextProps.workflowStatus === WORKFLOW_STATUS_RUNNING) {
            for (let i = 0; i < nextProps.gcodePrintingInfo.sent; i++) {
                this.gcodeRenderer && this.gcodeRenderer.setFrameIndex(i);
            }
            this.startToolheadRotationAnimation();
            this.renderScene();
        }
        if (this.props.workflowStatus !== WORKFLOW_STATUS_PAUSED && nextProps.workflowStatus === WORKFLOW_STATUS_PAUSED) {
            this.stopToolheadRotationAnimation();
        }
        if (nextProps.gcodePrintingInfo.sent > 0 && nextProps.gcodePrintingInfo.sent !== this.props.gcodePrintingInfo.sent) {
            this.updateWorkPosition(this.props.workPosition);
            this.gcodeRenderer && this.gcodeRenderer.setFrameIndex(nextProps.gcodePrintingInfo.sent);
            this.renderScene();
        }
    }

    componentWillUnmount() {
        this.unsubscribe();
        this.removeControllerEvents();
    }

    setupTargetPoint() {
        this.targetPoint = new TargetPoint({
            color: colornames('indianred'),
            radius: 0.5
        });
        this.modelGroup.add(this.targetPoint);
    }

    setupToolhead() {
        const color = colornames('silver');
        const url = 'textures/brushed-steel-texture.jpg';
        loadTexture(url, (err, texture) => {
            this.toolhead = new ToolHead(color, texture);
            this.modelGroup.add(this.toolhead);

            this.toolheadRotationAnimation = new TWEEN.Tween(this.toolhead.rotation)
                .to({ x: 0, y: 0, z: Number.MAX_VALUE }, Number.MAX_VALUE);
        });
    }

    calculateBoundingBox(gcodeList) {
        const box = new THREE.Box3();

        for (const gcodeInfo of gcodeList) {
            const gcodeObject = this.gcodeRenderer.group.getObjectByName(gcodeInfo.uniqueName);

            // The model group's position and rotation is changed by MSRControl, we can not
            // call box.expandByObject() directly.
            const geometry = gcodeObject.geometry;
            if (geometry !== undefined && geometry.isGeometry) {
                const vertices = geometry.vertices;
                for (let i = 0, l = vertices.length; i < l; i++) {
                    box.expandByPoint(vertices[i]);
                }
            }
        }

        const bbox = { min: box.min, max: box.max };

        // Set gcode bounding box
        /*
        controller.context = {
            ...controller.context,
            xmin: bbox.min.x,
            xmax: bbox.max.x,
            ymin: bbox.min.y,
            ymax: bbox.max.y,
            zmin: bbox.min.z,
            zmax: bbox.max.z
        };
        */
        const context = {
            ...controller.context,
            xmin: bbox.min.x,
            xmax: bbox.max.x,
            ymin: bbox.min.y,
            ymax: bbox.max.y,
            zmin: bbox.min.z,
            zmax: bbox.max.z
        };
        controller.context = context;

        pubsub.publish('gcode:bbox', bbox);

        return bbox;
    }

    loadGcode(gcodeList) {
        gcodeList = gcodeList || this.props.gcodeList;
        if (gcodeList.length === 0) {
            return;
        }

        // Upload G-code to controller if connected
        const { port } = this.state;
        if (!port) {
            return;
        }

        const name = gcodeList[0].name;
        const gcode = gcodeList.map(gcodeBean => gcodeBean.gcode).join('\n');

        this.props.loadGcode(port, name, gcode);
    }

    unloadGcode() {
        this.props.unloadGcode();
    }

    subscribe() {
        const tokens = [
            pubsub.subscribe('resize', () => {
                this.canvas.current.resizeWindow();
            }),
            pubsub.subscribe('gcode:render', (msg, { name, gcode }) => {
                this.setState(state => ({
                    gcode: {
                        ...state.gcode,
                        name: name,
                        content: gcode
                    }
                }), () => {
                    this.renderGcodeObjects();
                    this.loadGcode();
                });
            }),
            pubsub.subscribe('gcode:unload', () => {
                controller.command('gcode:unload');
                this.props.clearGcode();
            })
        ];
        this.pubsubTokens = this.pubsubTokens.concat(tokens);
    }

    unsubscribe() {
        this.pubsubTokens.forEach((token) => {
            pubsub.unsubscribe(token);
        });
        this.pubsubTokens = [];
    }

    addControllerEvents() {
        Object.keys(this.controllerEvents).forEach(eventName => {
            const callback = this.controllerEvents[eventName];
            controller.on(eventName, callback);
        });
    }

    removeControllerEvents() {
        Object.keys(this.controllerEvents).forEach(eventName => {
            const callback = this.controllerEvents[eventName];
            controller.off(eventName, callback);
        });
    }

    updateGcodeFilename(name, x = 0, y = 0, z = 0) {
        this.gcodeFilenameObject && this.modelGroup.remove(this.gcodeFilenameObject);
        const textSize = 5;
        this.gcodeFilenameObject = new TextSprite({
            x: x,
            y: y,
            z: z,
            size: textSize,
            text: `G-code: ${name}`,
            color: colornames('gray 44'), // grid color
            opacity: 0.5
        });
        this.gcodeFilenameObject.visible = this.state.gcodeFilenameVisible;
        this.modelGroup.add(this.gcodeFilenameObject);
    }

    startToolheadRotationAnimation() {
        this.toolheadRotationAnimation.start();
    }

    stopToolheadRotationAnimation() {
        this.toolheadRotationAnimation.stop();
    }

    updateWorkPositionToZero() {
        this.updateWorkPosition({
            x: '0.000',
            y: '0.000',
            z: '0.000',
            e: '0.000'
        });
    }

    updateWorkPosition(pos) {
        this.setState({
            workPosition: {
                ...this.state.workPosition,
                ...pos
            }
        });
        let { x = 0, y = 0, z = 0 } = { ...pos };
        x = (Number(x) || 0);
        y = (Number(y) || 0);
        z = (Number(z) || 0);
        this.toolhead && this.toolhead.position.set(x, y, z);
        this.targetPoint && this.targetPoint.position.set(x, y, z);
    }

    autoFocus(name = '') {
        if (!name && this.props.gcodeList.length !== 0) {
            name = this.props.gcodeList[0].uniqueName;
        }
        const gcodeObject = this.modelGroup.getObjectByName(name);
        this.canvas.current.autoFocus(gcodeObject);
    }

    clearGcodeObjects() {
        this.gcodeRenderer && this.modelGroup.remove(this.gcodeRenderer.group);

        this.setState(state => ({
            gcode: {
                ...state.gcode,
                renderState: 'idle'
            }
        }));
    }

    // Render G-code objects based on gcodeList, if not provided, use that in props.
    renderGcodeObjects(gcodeList) {
        gcodeList = gcodeList || this.props.gcodeList;

        // Stop animation
        this.stopToolheadRotationAnimation();
        this.updateWorkPositionToZero();
        // Remove G-code objects
        this.clearGcodeObjects();

        // Actually remove all objects
        if (gcodeList.length === 0) {
            this.setState(state => ({
                gcode: {
                    ...state.gcode,
                    renderState: 'idle'
                }
            }));
            return;
        }

        // Change state to 'rendering'
        this.setState(state => ({
            gcode: {
                ...state.gcode,
                renderState: 'rendering'
            }
        }));

        // Change state back to 'rendered' after a while
        setTimeout(() => {
            this.gcodeRenderer = new GCodeRenderer();
            this.modelGroup.add(this.gcodeRenderer.group);

            for (const gcodeInfo of gcodeList) {
                this.gcodeRenderer.renderGcode(gcodeInfo.gcode, gcodeInfo.uniqueName, gcodeInfo.renderMethod);
            }

            // Change state to 'rendered'
            this.setState(state => ({
                gcode: {
                    ...state.gcode,
                    renderState: 'rendered'
                }
            }));

            // Auto focus on first item
            this.autoFocus(gcodeList[0].uniqueName);

            // Update bounding box & filename
            const bbox = this.calculateBoundingBox(gcodeList);
            const x = bbox.min.x + (bbox.max.x - bbox.min.x) / 2;
            const y = bbox.min.y - 5;
            this.updateGcodeFilename(gcodeList[0].name, x, y);
        }, 100);
    }

    renderScene() {
        this.canvas.current.renderScene();
    }

    render() {
        const state = this.state;

        return (
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
                <div className={styles['canvas-content']}>
                    {this.props.uploadState === 'uploading' && <Loading />}
                    {state.gcode.renderState === 'rendering' && <Rendering />}
                    <div style={{ position: 'absolute', top: '10px', left: '10px', right: '10px' }}>
                        <WorkflowControl
                            workflowStatus={this.props.workflowStatus}
                            isConnected={this.props.isConnected}
                            connectionType={this.props.connectionType}
                            state={state}
                            actions={this.actions}
                            uploadState={this.props.uploadState}
                        />
                    </div>
                    <Canvas
                        ref={this.canvas}
                        size={this.props.size}
                        modelGroup={this.modelGroup}
                        printableArea={this.printableArea}
                        cameraInitialPosition={new THREE.Vector3(0, 0, 150)}
                    />
                </div>
                <div className={styles['canvas-footer']}>
                    <SecondaryToolbar
                        zoomIn={this.actions.zoomIn}
                        zoomOut={this.actions.zoomOut}
                        autoFocus={this.actions.autoFocus}
                    />
                </div>
                {state.showEnclosureDoorWarn && (
                    <Modal
                        disableOverlay
                        showCloseButton={false}
                    >
                        <Modal.Body>
                            <div style={{ display: 'flex' }}>
                                <i className="fa fa-exclamation-circle fa-4x text-danger" />
                                <div style={{ marginLeft: 25 }}>
                                    <h5>{i18n._('Enclosure door was opened')}</h5>
                                    <p>{i18n._('The enclosure door needs to be closed before laser or CNC printing')}</p>
                                </div>
                            </div>
                        </Modal.Body>
                        <Modal.Footer>
                            <Button
                                btnStyle="primary"
                                onClick={this.actions.closeModal}
                            >
                                {i18n._('Ok')}
                            </Button>
                        </Modal.Footer>
                    </Modal>
                )}
            </div>
        );
    }
}

const mapStateToProps = (state) => {
    const machine = state.machine;
    const workspace = state.workspace;
    return {
        size: machine.size,
        enclosure: machine.enclosure,
        enclosureDoor: machine.enclosureDoor,
        headType: machine.headType,
        workflowStatus: machine.workflowStatus,
        isConnected: machine.isConnected,
        connectionType: machine.connectionType,
        uploadState: workspace.uploadState,
        gcodeList: workspace.gcodeList,
        gcodePrintingInfo: machine.gcodePrintingInfo,
        workPosition: machine.workPosition
    };
};

const mapDispatchToProps = (dispatch) => ({
    addGcode: (name, gcode, renderMethod) => dispatch(actions.addGcode(name, gcode, renderMethod)),
    uploadGcodeFile: (file) => dispatch(actions.uploadGcodeFile(file)),
    clearGcode: () => dispatch(actions.clearGcode()),
    loadGcode: (port, name, gcode) => dispatch(actions.loadGcode(port, PROTOCOL_TEXT, name, gcode)),
    unloadGcode: () => dispatch(actions.unloadGcode()),

    startServerGcode: (callback) => dispatch(machineActions.startServerGcode(callback)),
    pauseServerGcode: () => dispatch(machineActions.pauseServerGcode()),
    resumeServerGcode: (callback) => dispatch(machineActions.resumeServerGcode(callback)),
    stopServerGcode: () => dispatch(machineActions.stopServerGcode())
});

export default connect(mapStateToProps, mapDispatchToProps)(Visualizer);
