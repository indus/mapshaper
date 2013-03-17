/* @requires shapefile-import, dbf-import, mapshaper-common */

// Reads Shapefile data from an ArrayBuffer or Buffer
// Converts to format used for identifying topology.
//

MapShaper.importDbf = function(src) {
  T.start();
  var data = new DbfReader(src, {format: table}).read();
  T.stop("[importDbf()]");
  return data;
};


MapShaper.importShp = function(src) {
  T.start();
  var reader = new ShapefileReader(src);
  var supportedTypes = {
    5: "polygon",
    3: "polyline"
  };

  if (reader.type() in supportedTypes == false) {
    stop("Only polygon and polyline (type 5 and 3) Shapefiles are supported.");
  }

  var counts = reader.getCounts(),
      xx = new Float64Array(counts.pointCount),
      yy = new Float64Array(counts.pointCount),
      partIds = new Uint32Array(counts.pointCount),   
      shapeIds = [];

  var expectRings = reader.type() == 5,
      findMaxParts = expectRings,
      maxPartFlags = findMaxParts ? new Uint8Array(counts.partCount) : null,
      findHoles = expectRings,
      holeFlags = findHoles ? new Uint8Array(counts.partCount) : null;

  var pointId = 0, 
      partId = 0,
      shapeId = 0,
      holeCount = 0;

  reader.forEachShape(function(shp) {
    var maxPartId = -1,
        maxPartArea = 0,
        signedPartArea, partArea;

    var partsInShape = shp.partCount,
        pointsInShape = shp.pointCount,
        partSizes = shp.getPartSizes(),
        coords = shp.getCoords(),
        pointsInPart;

    if (partsInShape != partSizes.length) error("Shape part mismatch");

    for (var j=0, offs=0; j<partsInShape; j++) {
      pointsInPart = partSizes[j];
      for (var i=0; i<pointsInPart; i++) {
        xx[pointId] = coords[offs++];
        yy[pointId] = coords[offs++];
        partIds[pointId] = partId;
        pointId++;
      }


      if (expectRings) {
        signedPartArea = msSignedRingArea(xx, yy, pointId - pointsInPart, pointsInPart);
        if (signedPartArea == 0) error("A ring in shape", shapeId, "has zero area or is not closed");
        if (findMaxParts) {
          partArea = Math.abs(signedPartArea);
          if (partArea > maxPartArea) {
            maxPartId = partId;
            maxPartArea = partArea;
          }
        }

        if (findHoles) {
          if (signedPartArea < 0) {
            if (partsInShape == 1) error("Shape", shapeId, "only contains a hole");
            holeFlags[partId] = 1;
            holeCount++;
          }
        }              
      }

      shapeIds.push(shapeId);
      partId++;
    }  // forEachPart()

    if (maxPartId > -1) {
      maxPartFlags[maxPartId] = 1;
    }
    shapeId++;
  });  // forEachShape()

  if (counts.pointCount != pointId || counts.partCount != partId || counts.shapeCount != shapeId)
    error("Counting problem");

  var info = {
    // shapefile_header: this.header
    input_point_count: pointId,
    input_part_count: partId,
    input_shape_count: shapeId,
    input_geometry_type: expectRings ? "polygon" : "polyline"
  };
  T.stop("Import Shapefile");
  return {
    xx: xx,
    yy: yy,
    partIds: partIds,
    shapeIds: shapeIds,
    maxPartFlags: maxPartFlags,
    holeFlags: holeFlags,
    info: info
  };
};



// Convert topological data to buffers containing .shp and .shx file data
//
MapShaper.exportShp = function(arcs, shapes, shpType) {
  if (!Utils.isArray(arcs) || !Utils.isArray(shapes)) error("Missing exportable data.");
  T.start();
  T.start();
  var fileBytes = 100;
  var bounds = new BoundingBox();
  var shapeBuffers = Utils.map(shapes, function(shape, i) {
    var shpObj = MapShaper.exportShpRecord(shape, arcs, i+1, shpType);
    fileBytes += shpObj.buffer.byteLength;
    shpObj.bounds && bounds.mergeBounds(shpObj.bounds);
    return shpObj.buffer;
  });
  T.stop("export shape records");

  T.start();

  // write .shp header section
  var shpBin = new BinArray(fileBytes, false)
    .writeInt32(9994)
    .skipBytes(5 * 4)
    .writeInt32(fileBytes / 2)
    .littleEndian()
    .writeInt32(1000)
    .writeInt32(shpType)
    .writeFloat64(bounds.left)
    .writeFloat64(bounds.bottom)
    .writeFloat64(bounds.right)
    .writeFloat64(bounds.top)
    .skipBytes(4 * 8); // skip Z & M type bounding boxes;

  // write .shx header
  var shxBytes = 100 + shapeBuffers.length * 8;
  var shxBin = new BinArray(shxBytes, false)
    .writeBuffer(shpBin.buffer(), 100) // copy .shp header to .shx
    .position(24)
    .bigEndian()
    .writeInt32(shxBytes/2)
    .littleEndian()
    .position(100);

  // write record sections of .shp and .shx
  Utils.forEach(shapeBuffers, function(buf) {
    shxBin.writeInt32(shpBin.position() / 2)
    shxBin.writeInt32((buf.byteLength - 8) / 2); // content length
    // alternative: shxBin.writeBuffer(buf, 4, 4);
    shpBin.writeBuffer(buf);
  });
  var shxBuf = shxBin.buffer(),
      shpBuf = shpBin.buffer();
  T.stop("convert to binary");
  T.stop("Export Shapefile");
  return {shp: shpBuf, shx: shxBuf};
};


// Returns an ArrayBuffer containing a Shapefile record for one shape
//   and the bounding box of the shape.
//
MapShaper.exportShpRecord = function(shape, arcs, id, shpType) {
  var bounds = null,
      bin;
  if (!shape || shape.length == 0) {
    bin = new BinArray(12, false)
      .writeInt32(id)
      .writeInt32(2)
      .littleEndian()
      .writeInt32(0);
  }
  else {
    var data = MapShaper.convertTopoShape(shape, arcs),
        bounds = data.bounds,
        partsIdx = 52,
        pointsIdx = partsIdx + 4 * data.partCount,
        recordBytes = pointsIdx + 16 * data.pointCount,
        pointCount = 0;

    bin = new BinArray(recordBytes, false)
      .writeInt32(id)
      .writeInt32((recordBytes - 8) / 2)
      .littleEndian()
      .writeInt32(shpType)
      .writeFloat64(bounds.left)
      .writeFloat64(bounds.bottom)
      .writeFloat64(bounds.right)
      .writeFloat64(bounds.top)
      .writeInt32(data.partCount)
      .writeInt32(data.pointCount);

    Utils.forEach(data.parts, function(part, i) {
      bin.position(partsIdx + i * 4)
        .writeInt32(pointCount)
        .position(pointsIdx + pointCount * 16);
      var xx = part[0],
          yy = part[1];
      for (var j=0, len=xx.length; j<len; j++) {
        bin.writeFloat64(xx[j]);
        bin.writeFloat64(yy[j]);
      }
      pointCount += j;
    });
    if (data.pointCount != pointCount) error("Shp record point count mismatch; pointCount:"
        , pointCount, "data.pointCount:", data.pointCount);
  }
  return {bounds: bounds, buffer: bin.buffer()};
};

