import { sharedEventDispatcher } from "./event"
import * as pixl from "./pixl.ble"
import * as ByteBuffer from "bytebuffer"

const MTU_SIZE = 250
const MTU_MAX_DATA_SIZE = 247
const DF_HEADER_SIZE = 4
const DF_MAX_DATA_SIZE = MTU_MAX_DATA_SIZE - DF_HEADER_SIZE

var op_queue = []
var op_ongoing = false

export function op_queue_push(cmd, tx_data_cb, rx_data_cb) {
    return new Promise((resolve, reject) => {
        var op = {
            cmd: cmd,
            tx_data_cb: tx_data_cb,
            rx_data_cb: rx_data_cb,
            p_resolve: resolve,
            p_reject: reject
        }
        op_queue.push(op);
        process_op_queue();
    });

}

function process_op_queue() {
    if (!op_ongoing && op_queue.length > 0) {
        var op = op_queue.shift();
        proocess_op(op);
    }
}

function proocess_op(op) {
    new_rx_promise().then(data => {
        var bb = ByteBuffer.wrap(data);
        var h = read_header(bb);
        h.data = op.rx_data_cb(bb);
        op_ongoing = false;
        op.p_resolve(h);
        process_op_queue();
        return h;
    }).catch(e => {
        op_ongoing = false;
        op.p_reject(e);
        process_op_queue();
    });

    var bb = new ByteBuffer();
    op.tx_data_cb(bb);
    op_ongoing = true;
    tx_data_frame(op.cmd, 0, 0, bb).catch(e => {
        op.p_reject(e);
    });
}


var m_api_resolve;
var m_api_reject;

export function init() {
    sharedEventDispatcher().addListener("ble_rx_data", on_rx_data);
    sharedEventDispatcher().addListener("ble_disconnected", on_ble_disconnected);
    ByteBuffer.DEFAULT_ENDIAN = ByteBuffer.LITTLE_ENDIAN;
}

export function get_version() {
    console.log("get_version");
    return op_queue_push(0x01,
        b => { },
        b => {
            return {
                ver: read_string(b)
            }
        });
}

export function enter_dfu() {
    console.log("enter_dfu");
    return op_queue_push(0x02,
        b => { },
        b => { });
}

export function vfs_get_drive_list() {
    console.log("vfs_get_drive_list");
    return op_queue_push(0x10,
        b => { },
        b => {
            var drives = [];
            var d_cnt = b.readUint8();
            if (d_cnt > 0) {
                var drive = {};
                drive.status = b.readUint8();
                drive.label = String.fromCharCode(b.readByte());
                drive.name = read_string(b);
                drive.total_size = b.readUint32();
                drive.used_size = b.readUint32();

                drives.push(drive);
            }
            return drives;
        });
}

export function vfs_read_folder(dir) {
    console.log("vfs_read_dir", dir);
    return op_queue_push(0x16,
        b => { write_string(b, dir); },
        bb => {
            var files = [];
            while (bb.remaining() > 0) {
                var file = {};
                file.name = read_string(bb);
                file.size = bb.readUint32();
                file.type = bb.readUint8();
                files.push(file);
            }
            return files;
        });

}

export function vfs_create_folder(dir) {
    console.log("vfs_create_folder", dir);

    return op_queue_push(0x17,
        b => { write_string(b, dir); },
        b => {});
}

export function vfs_remove(path) {
    console.log("vfs_remove", path);

    return op_queue_push(0x18,
        b => { write_string(b, path); },
        b => {});
}

export function vfs_open_file(path, mode) {
    console.log("vfs_open_file", path, mode);
    return op_queue_push(0x12,
        b => {
            write_string(b, path);
            if (mode == 'r') {
                b.writeUint8(0x8); //readonly
            } else if (mode == 'w') {
                b.writeUint8(0x16); //truc, create, write
            }

        },
        b => {
            return {
                file_id: b.readUint8()
            }
        });


    return p;
}

export function vfs_close_file(file_id) {
    console.log("vfs_close_file", file_id);

    return op_queue_push(0x13,
        b => { b.writeUint8(file_id) },
        b => { });
}

export function vfs_read_file(file_id) {
    console.log("vfs_read_file", file_id);
    return op_queue_push(0x14,
        b => { b.writeUint8(file_id) },
        b => { return b.readBytes(b.remaining()) });
}

export function vfs_write_file(file_id, data) {
    console.log("vfs_write_file", file_id);
    return op_queue_push(0x15,
        b => {
            b.writeUint8(file_id);
            write_bytes(b, data);
        },
        b => { });
}

var file_write_queue = []
var file_write_ongoing = false

export function vfs_helper_write_file(path, file, progress_cb, success_cb, error_cb) {
    file_write_queue.push({
        path: path,
        file: file,
        progress_cb: progress_cb,
        success_cb: success_cb,
        error_cb: error_cb
    });
    vfs_process_file_write_queue();
}

function vfs_process_file_write_queue() {
    if (!file_write_ongoing && file_write_queue.length > 0) {
        var e = file_write_queue.shift();
        file_write_ongoing = true;
        vfs_process_file_write(e.path, e.file, e.progress_cb, e.success_cb, e.error_cb, _ => {
            file_write_ongoing = false;
            vfs_process_file_write_queue();
        });

    }
}

function vfs_process_file_write(path, file, progress_cb, success_cb, error_cb, done_cb) {
    read_file_as_bytebuffer(file).then(buffer => {
        vfs_open_file(path, "w").then(res => {
            if (res.status != 0) {
                error_cb(new Error("create file failed!"));
                done_cb();
                return;
            }
            //分批写入

            var state = {
                file: file,
                file_id: res.data.file_id,
                write_offset: 0,
                file_size: buffer.remaining(),
                batch_size: DF_MAX_DATA_SIZE - 1,
                data_buffer: buffer
            }

            function vfs_write_cb() {
                if (state.write_offset < state.file_size) {
                    //vfs write 
                    const batch_size = Math.min(state.batch_size,
                        state.file_size - state.write_offset);
                    const data_buffer = state.data_buffer.slice(state.write_offset, state.write_offset + batch_size);
                    console.log("vfs_write_cb", state.write_offset, batch_size);
                    vfs_write_file(state.file_id, data_buffer).then(data => {
                        state.write_offset += batch_size;
                        progress_cb({ written_bytes: state.write_offset, total_bytes: state.file_size }, state.file);
                        vfs_write_cb();
                    }).catch(e => {
                        vfs_close_file(state.file_id).then(data => {
                            error_cb(e, state.file);
                            done_cb();
                        }).catch(e => {
                            error_cb(e, state.file);
                            done_cb();
                        })
                    });
                } else {
                    vfs_close_file(state.file_id).then(data => {
                        success_cb(state.file);
                        done_cb();
                    }).catch(e => {
                        error_cb(e, state.file);
                        done_cb();
                    })
                }
            }

            vfs_write_cb();
        })
    });

}


function read_file_as_bytebuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function () {
            resolve(ByteBuffer.wrap(reader.result));
        }
        reader.onerror = function () {
            reject(reader.error);
        }

        reader.readAsArrayBuffer(file);
    });
}

function read_header(bb) {
    return {
        cmd: bb.readUint8(),
        status: bb.readUint8(),
        chunk: bb.readUint16()
    }
}


function decode_utf8(bytes) {
    var encoded = "";
    for (var i = 0; i < bytes.length; i++) {
        encoded += '%' + bytes[i].toString(16);
    }
    return decodeURIComponent(encoded);
}

function encode_utf8(text) {
    var code = encodeURIComponent(text);
    var bytes = [];
    for (var i = 0; i < code.length; i++) {
        const c = code.charAt(i);
        if (c === '%') {
            const hex = code.charAt(i + 1) + code.charAt(i + 2);
            const hexVal = parseInt(hex, 16);
            bytes.push(hexVal);
            i += 2;
        } else bytes.push(c.charCodeAt(0));
    }
    return bytes;
}

function read_string(bb) {
    var size = bb.readUint16();
    var bytes = []
    for (var i = 0; i < size; i++) {
        bytes.push(bb.readUint8());
    }
    return decode_utf8(bytes);
}

function write_string(bb, str) {
    var bytes = encode_utf8(str);
    bb.writeUint16(bytes.length);
    for (var i = 0; i < bytes.length; i++) {
        bb.writeUint8(bytes[i]);
    }
}

function write_bytes(bb, buffer) {
    var size = buffer.remaining();
    for (var i = 0; i < size; i++) {
        bb.writeUint8(buffer.readUint8());
    }
}

function tx_data_frame(cmd, status, chunk, data) {
    var bb = new ByteBuffer();
    bb.writeUint8(cmd);
    bb.writeUint8(status);
    bb.writeUint16(chunk);
    if (data) {
        data.flip();
        var data_remain = data.remaining();
        for (var i = 0; i < data_remain; i++) {
            bb.writeByte(data.readByte());
        }
    }
    bb.flip();
    return pixl.tx_data(bb.toArrayBuffer());
}



function new_rx_promise() {
    return new Promise((resolve, reject) => {
        m_api_reject = reject;
        m_api_resolve = resolve;
    });
}


var rx_bytebuffer = new ByteBuffer();
var rx_chunk_state = "NONE"; //NONE CHUNK,


function on_rx_data(data) {
    var buff = ByteBuffer.wrap(data);
    var h = read_header(buff);
    if(h.chunk & 0x8000){
        if(rx_chunk_state == "NONE"){
            write_bytes(rx_bytebuffer, ByteBuffer.wrap(data));
            rx_chunk_state = "CHUNK";
        }else if(rx_chunk_state == "CHUNK"){
            write_bytes(rx_bytebuffer, buff); //next chunk, ignore header
        }
    }else{
        var cb_data = data;
        if(rx_chunk_state == "CHUNK"){ //end of chunk
            write_bytes(rx_bytebuffer, buff); 
            rx_bytebuffer.flip();
            cb_data = rx_bytebuffer.toArrayBuffer();
        }else if(rx_chunk_state == "NONE"){ //single chunk
            cb_data = data;
        }
        
        //call back 
        if (m_api_resolve) {
            m_api_resolve(cb_data);
            m_api_resolve = null;
           
        }
        rx_chunk_state = "NONE";
    }
}


function on_ble_disconnected(){
    rx_bytebuffer.clear();
    rx_chunk_state = "NONE";
    
    m_api_resolve = null;
    m_api_reject = null;

    file_write_queue = [];
    file_write_ongoing = false;

    op_queue = [];
    op_ongoing = false;

}

